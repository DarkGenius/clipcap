#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const logFile = join(__dirname, 'host.log');

const execFileAsync = promisify(execFile);

// Храним активные процессы загрузки
const downloadProcesses = new Map();
// URL, для которых была запрошена отмена (чтобы корректно определить причину завершения)
const cancelledDownloads = new Set();

// Функция логирования
async function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  try {
    await appendFile(logFile, logMessage);
    console.error(logMessage.trim()); // Также выводим в stderr для отладки
  } catch (err) {
    console.error('Log error:', err);
  }
}

function readMessage() {
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(4);
    process.stdin.once('readable', () => {
      const chunk = process.stdin.read(4);
      if (!chunk) return reject(new Error('No length header'));
      chunk.copy(header);
      const msgLen = header.readUInt32LE(0);
      const msgBuf = process.stdin.read(msgLen);
      if (!msgBuf) return reject(new Error('No message body'));
      try {
        resolve(JSON.parse(msgBuf.toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function writeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  process.stdout.write(len);
  process.stdout.write(json);
}

async function handleMessage(msg) {
  try {
    await log(`Received message: ${JSON.stringify(msg)}`);

    if (msg.type === 'host:exec') {
      const { command, args = [] } = msg;
      await log(`Executing: ${command} ${args.join(' ')}`);
      const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5000 });
      await log(`Exec result: stdout=${stdout.length} bytes, stderr=${stderr.length} bytes`);
      return { ok: true, kind: 'exec', stdout, stderr };
    }
    if (msg.type === 'host:list') {
      const path = msg.path || '.';
      await log(`Listing directory: ${path}`);
      const entries = await readdir(path, { withFileTypes: true });
      const list = entries.map(e => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() }));
      await log(`Found ${list.length} entries`);
      return { ok: true, kind: 'list', path, entries: list };
    }
    if (msg.type === 'host:ytdlp-check') {
      const { ytdlpPath, url } = msg;
      await log(`YT-DLP check: path=${ytdlpPath}, url=${url}`);
      try {
        await log(`Executing yt-dlp...`);
        const { stdout, stderr } = await execFileAsync(ytdlpPath, ['--list-formats', url], { timeout: 30000 });
        await log(`YT-DLP output length: ${stdout.length} bytes`);
        await log(`YT-DLP stdout (first 1000 chars): ${stdout.substring(0, 1000)}`); // Первые 1000 символов

        // Парсим вывод yt-dlp
        let result = await parseYtDlpOutput(stdout, url);
        await log(`Parse result: success=${result.success}, resolution=${result.resolution}, filesize=${result.filesize}`);

        let downloadUrl = null;
        let pathname = '';
        try {
          pathname = new URL(url).pathname;
        } catch (e) {}
        const isHls = pathname.endsWith('.m3u8');

        if (result.success && isHls) {
          const content = await fetchText(url);
          const isMaster = !!(content && content.includes('#EXT-X-STREAM-INF'));
          let masterUrl = isMaster ? url : null;
          let masterContent = isMaster ? content : null;

          // Мастер-плейлист рядом с медиа-плейлистом уточняет разрешение
          // и даёт BANDWIDTH варианта для оценки размера
          if (!isMaster && content) {
            const needMaster = !/^\d+x\d+$/.test(result.resolution || '') || !result.filesize;
            const master = needMaster ? await findMasterPlaylist(url, content) : null;
            if (master) {
              masterUrl = master.masterUrl;
              masterContent = master.content;
              // Уточняем разрешение по мастеру только если удалось определить, какому
              // варианту соответствует проверяемый URL — иначе показывали бы чужое
              if (!/^\d+x\d+$/.test(result.resolution || '') && master.variantResolution) {
                await log(`Re-checking with master playlist: ${master.masterUrl} (variant: ${master.variantResolution})`);
                try {
                  const { stdout: masterStdout } = await execFileAsync(ytdlpPath, ['--list-formats', master.masterUrl], { timeout: 30000 });
                  const masterResult = await parseYtDlpOutput(masterStdout, master.masterUrl, master.variantResolution);
                  if (masterResult.success && masterResult.resolution === master.variantResolution) {
                    result = masterResult;
                    downloadUrl = master.masterUrl;
                    await log(`Master playlist result: resolution=${result.resolution}, filesize=${result.filesize}, formatId=${result.formatId}`);
                  }
                } catch (masterErr) {
                  await log(`Master playlist check failed: ${masterErr.message || String(masterErr)}`);
                }
              }
            }
          }

          // Длительность (и оценка размера, если yt-dlp его не дал) считаем по самому
          // плейлисту: для ряда CDN (например, Cloudflare Stream) yt-dlp не сообщает ни то, ни другое
          const meta = await getHlsMeta(url, content, masterUrl, masterContent, result.resolution);
          if (meta && meta.duration) {
            result.duration = Math.round(meta.duration);
            await log(`HLS duration: ${result.duration}s (${formatDuration(result.duration)})`);
            if (!result.filesize && meta.bandwidth) {
              result.filesize = '~' + formatBytes(meta.bandwidth * meta.duration / 8);
              await log(`Filesize estimated from bandwidth ${meta.bandwidth}: ${result.filesize}`);
            }
          }
        }

        // DASH-манифест: длительность и битрейт берём из самого MPD —
        // yt-dlp для ряда CDN (Cloudflare Stream) не сообщает ни того, ни другого
        if (result.success && pathname.endsWith('.mpd')) {
          const meta = await getDashMeta(url, result.resolution);
          if (meta && meta.duration) {
            result.duration = Math.round(meta.duration);
            await log(`DASH duration: ${result.duration}s (${formatDuration(result.duration)})`);
            if (!result.filesize && meta.bandwidth) {
              result.filesize = '~' + formatBytes(meta.bandwidth * meta.duration / 8);
              await log(`Filesize estimated from bandwidth ${meta.bandwidth}: ${result.filesize}`);
            }
          }
        }

        // Для прямых видеофайлов уточняем размер и разрешение сами.
        // Проверяем расширение явно: манифесты (.mpd) сюда попадать не должны,
        // иначе Content-Length манифеста уехал бы в размер видео
        if (result.success && MEDIA_FILE_EXTENSIONS.test(pathname)) {
          let contentLength = null;
          if (!result.filesize) {
            contentLength = await fetchContentLength(url);
            if (contentLength) {
              result.filesize = formatBytes(contentLength);
              await log(`Filesize from Content-Length: ${result.filesize}`);
            }
          }
          // Разрешение неизвестно или угадано — парсим tkhd из самого файла (точно)
          if (/\.(mp4|m4v|mov)$/i.test(pathname) && !/^\d+x\d+$/.test(result.resolution || '')) {
            const probed = await probeMp4Resolution(url, contentLength);
            if (probed) {
              result.resolution = probed;
              await log(`Resolution from mp4 tkhd box: ${probed}`);
            }
          }
        }

        const response = {
          ok: true,
          kind: 'ytdlp-check',
          type: 'ytdlp-check-result',
          url: url,
          downloadUrl: downloadUrl,
          success: result.success,
          formatId: result.formatId,
          resolution: result.resolution,
          filesize: result.filesize,
          duration: result.duration || null,
          error: result.error
        };
        await log(`Sending response: ${JSON.stringify(response)}`);
        return response;
      } catch (err) {
        await log(`YT-DLP error: ${err.message || String(err)}`);
        const errorResponse = {
          ok: true,
          kind: 'ytdlp-check',
          type: 'ytdlp-check-result',
          url: url,
          success: false,
          error: 'Ошибка выполнения yt-dlp: ' + (err.message || String(err))
        };
        await log(`Sending error response: ${JSON.stringify(errorResponse)}`);
        return errorResponse;
      }
    }
    if (msg.type === 'host:ytdlp-download') {
      const { ytdlpPath, formatId, url, downloadUrl, outputPath, filename } = msg;
      // downloadUrl — альтернативный URL для yt-dlp (например, мастер-плейлист),
      // при этом url остается ключом для прогресса и отмены
      const targetUrl = downloadUrl || url;
      await log(`YT-DLP download: formatId=${formatId}, url=${url}, targetUrl=${targetUrl}, output=${outputPath}/${filename}`);

      try {
        const fullPath = join(outputPath, filename);
        // Добавляем --newline для корректного вывода прогресса и --no-warnings чтобы игнорировать предупреждения
        const args = ['-f', formatId, targetUrl, '-o', fullPath, '--newline', '--no-warnings'];

        await log(`Spawning yt-dlp: ${ytdlpPath} ${args.join(' ')}`);

        // Используем spawn для получения потокового вывода
        const child = spawn(ytdlpPath, args);

        // Последняя строка ERROR: из вывода yt-dlp — передаётся расширению при сбое
        let lastErrorLine = null;

        // Сохраняем процесс для возможности отмены
        downloadProcesses.set(url, child);

        child.stdout.on('data', (data) => {
          const output = data.toString();
          // Убираем управляющие символы (например, \r) которые могут мешать парсингу
          const cleanOutput = output.replace(/\r/g, '\n').trim();
          log(`YT-DLP stdout: ${cleanOutput}`);

          const errMatches = cleanOutput.match(/ERROR:.*$/gm);
          if (errMatches) lastErrorLine = errMatches[errMatches.length - 1].trim();

          // Парсим прогресс из вывода yt-dlp
          // Пример: [download]  45.0% of 1.68GiB at 5.21MiB/s ETA 02:35
          // Пример с фрагментами: [download]   8.3% of ~   1.49GiB at    2.92MiB/s ETA 07:55 (frag 39/457)
          const progressMatch = cleanOutput.match(/\[download\]\s+([\d.]+)%/);
          if (progressMatch) {
            const percent = parseFloat(progressMatch[1]);
            // Извлекаем размер файла из строки прогресса (например, "of ~ 1.49GiB" или "of 1.68GiB")
            const sizeMatch = cleanOutput.match(/of\s+~?\s*([\d.]+\s*(?:B|KiB|MiB|GiB|TiB))/i);
            const msg = {
              type: 'ytdlp-download-progress',
              url: url,
              percent: percent,
              output: cleanOutput
            };
            if (sizeMatch) msg.filesize = sizeMatch[1].trim().replace(/\s+/g, '');
            writeMessage(msg);
          }
        });

        child.stderr.on('data', (data) => {
          const output = data.toString();
          // Убираем управляющие символы (например, \r) которые могут мешать парсингу
          const cleanOutput = output.replace(/\r/g, '\n').trim();
          log(`YT-DLP stderr: ${cleanOutput}`);

          const errMatches = cleanOutput.match(/ERROR:.*$/gm);
          if (errMatches) lastErrorLine = errMatches[errMatches.length - 1].trim();

          // yt-dlp может выводить прогресс в stderr
          const progressMatch = cleanOutput.match(/\[download\]\s+([\d.]+)%/);
          if (progressMatch) {
            const percent = parseFloat(progressMatch[1]);
            const sizeMatch = cleanOutput.match(/of\s+~?\s*([\d.]+\s*(?:B|KiB|MiB|GiB|TiB))/i);
            const msg = {
              type: 'ytdlp-download-progress',
              url: url,
              percent: percent,
              output: cleanOutput
            };
            if (sizeMatch) msg.filesize = sizeMatch[1].trim().replace(/\s+/g, '');
            writeMessage(msg);
          }
        });

        child.on('close', async (code) => {
          await log(`YT-DLP download finished with code: ${code}`);
          downloadProcesses.delete(url);

          const wasCancelled = cancelledDownloads.delete(url);

          if (code === 0) {
            writeMessage({
              type: 'ytdlp-download-complete',
              url: url,
              success: true,
              filepath: fullPath
            });
          } else if (code === null || wasCancelled) {
            // Процесс был убит
            writeMessage({
              type: 'ytdlp-download-complete',
              url: url,
              success: false,
              error: 'Загрузка отменена'
            });
          } else {
            writeMessage({
              type: 'ytdlp-download-complete',
              url: url,
              success: false,
              error: lastErrorLine
                ? `${lastErrorLine} (код: ${code})`
                : `Ошибка загрузки (код: ${code})`
            });
          }
        });

        // Немедленно возвращаем подтверждение что загрузка началась
        return { ok: true, kind: 'ytdlp-download', message: 'Download started' };
      } catch (err) {
        await log(`YT-DLP download error: ${err.message || String(err)}`);
        return {
          ok: false,
          error: 'Ошибка запуска загрузки: ' + (err.message || String(err))
        };
      }
    }
    if (msg.type === 'host:ytdlp-status') {
      // Возвращаем список URL, для которых в ЭТОМ экземпляре хоста реально идет загрузка.
      // После перезапуска хоста (перезагрузка расширения) список пуст —
      // расширение использует это для инвалидации зависших загрузок
      const activeUrls = Array.from(downloadProcesses.keys());
      await log(`YT-DLP status: ${activeUrls.length} active download(s)`);
      return {
        ok: true,
        kind: 'ytdlp-status',
        type: 'ytdlp-status-result',
        activeUrls: activeUrls
      };
    }
    if (msg.type === 'host:ytdlp-cancel') {
      const { url } = msg;
      await log(`YT-DLP cancel download: url=${url}`);

      const child = downloadProcesses.get(url);
      if (child) {
        await log(`Killing process for ${url} (pid=${child.pid})`);
        cancelledDownloads.add(url);
        if (process.platform === 'win32') {
          // yt-dlp.exe (PyInstaller) порождает дочерний процесс — убиваем все дерево,
          // иначе child.kill() завершает только родителя, а загрузка продолжается
          try {
            await execFileAsync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 5000 });
          } catch (killErr) {
            await log(`taskkill failed: ${killErr.message || String(killErr)}, falling back to child.kill()`);
            child.kill('SIGTERM');
          }
        } else {
          child.kill('SIGTERM');
        }
        downloadProcesses.delete(url);
        return { ok: true, kind: 'ytdlp-cancel', message: 'Download cancelled' };
      } else {
        await log(`No active download found for ${url}`);
        return { ok: false, error: 'No active download found' };
      }
    }
    if (msg.type === 'host:open-file') {
      const { filepath } = msg;
      await log(`Opening file: ${filepath}`);

      try {
        // На Windows используем команду start для открытия файла
        // Используем команду через cmd.exe для корректной работы start
        await execFileAsync('cmd.exe', ['/c', 'start', '', filepath], { timeout: 5000 });
        await log(`File opened successfully: ${filepath}`);
        return { ok: true, kind: 'open-file', message: 'File opened' };
      } catch (err) {
        await log(`Error opening file: ${err.message || String(err)}`);
        return {
          ok: false,
          error: 'Ошибка открытия файла: ' + (err.message || String(err))
        };
      }
    }
    await log(`Unknown message type: ${msg.type}`);
    return { ok: false, error: 'Unknown message type' };
  } catch (err) {
    await log(`Handle message error: ${err.message || String(err)}`);
    return { ok: false, error: String(err.message || err) };
  }
}

// Форматируем байты в стиле yt-dlp (1.27GiB, 490.71MiB)
function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(2)}${units[unitIndex]}`;
}

// Точный размер файла по Content-Length (HEAD-запрос) — для прямых видеофайлов
async function fetchContentLength(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    if (!res.ok) return null;
    const length = parseInt(res.headers.get('content-length'), 10);
    return Number.isFinite(length) && length > 0 ? length : null;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Скачиваем диапазон байтов файла (Range-запрос)
async function fetchRange(url, start, end, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: controller.signal
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Ищем в буфере MP4-box 'tkhd' (track header) и читаем из него width/height.
// У аудиодорожек размеры нулевые, поэтому берем первую ненулевую пару
function parseTkhdResolution(buf) {
  let idx = 0;
  while ((idx = buf.indexOf('tkhd', idx)) !== -1) {
    const boxStart = idx - 4; // 'tkhd' находится по смещению 4 от начала box (после size)
    if (boxStart < 0) {
      idx += 4;
      continue;
    }
    const version = buf[boxStart + 8];
    // v0: width по смещению 84 от начала box, v1 (64-битные времена): 96
    const widthOffset = boxStart + (version === 1 ? 96 : 84);
    if (widthOffset + 8 <= buf.length) {
      // width/height хранятся как fixed-point 16.16
      const width = buf.readUInt32BE(widthOffset) >>> 16;
      const height = buf.readUInt32BE(widthOffset + 4) >>> 16;
      if (width > 0 && height > 0 && width <= 8192 && height <= 8192) {
        return `${width}x${height}`;
      }
    }
    idx += 4;
  }
  return null;
}

// Ищем box 'moov' обходом боксов верхнего уровня (ftyp/free/mdat/moov/...):
// на каждый бокс — один 16-байтовый Range-запрос заголовка (size + type)
async function findMoovBox(url, total) {
  let offset = 0;
  for (let i = 0; i < 16 && offset + 16 <= total; i++) {
    const hdr = await fetchRange(url, offset, offset + 15);
    if (!hdr || hdr.length < 16) return null;
    let size = hdr.readUInt32BE(0);
    const type = hdr.toString('latin1', 4, 8);
    if (size === 1) size = Number(hdr.readBigUInt64BE(8)); // 64-битный largesize
    else if (size === 0) size = total - offset; // box до конца файла
    if (!/^[\x20-\x7e]{4}$/.test(type) || size < 8) return null; // не MP4-структура
    if (type === 'moov') return { offset, size };
    offset += size;
  }
  return null;
}

// Определяем разрешение прямого MP4-файла: качаем начало файла (там moov
// у web-оптимизированных файлов) и парсим tkhd; если не нашли — находим moov
// обходом боксов и качаем его с начала (tkhd видеодорожки лежит близко к началу
// moov; хвостовое окно фиксированного размера может его не захватить)
async function probeMp4Resolution(url, contentLength) {
  const CHUNK = 3 * 1024 * 1024;
  const head = await fetchRange(url, 0, CHUNK - 1);
  if (head) {
    const resolution = parseTkhdResolution(head);
    if (resolution) return resolution;
  }
  if (!contentLength) contentLength = await fetchContentLength(url);
  if (!contentLength || contentLength <= CHUNK) return null;
  const moov = await findMoovBox(url, contentLength);
  if (moov) {
    const MOOV_CAP = 16 * 1024 * 1024;
    const buf = await fetchRange(url, moov.offset, moov.offset + Math.min(moov.size, MOOV_CAP) - 1);
    if (buf) {
      const resolution = parseTkhdResolution(buf);
      if (resolution) return resolution;
    }
  }
  // Фолбэк на случай нестандартной структуры: просто хвост файла
  const tail = await fetchRange(url, contentLength - CHUNK, contentLength - 1);
  if (tail) {
    const resolution = parseTkhdResolution(tail);
    if (resolution) return resolution;
  }
  return null;
}

// Типичные имена мастер-плейлистов HLS
// video.m3u8 — имя мастер-плейлиста у Cloudflare Stream
const MASTER_PLAYLIST_NAMES = ['video.m3u8', 'playlist.m3u8', 'master.m3u8', 'index.m3u8', 'manifest.m3u8'];

// Прогрессивные видеофайлы — только для них имеет смысл HEAD/tkhd-зондирование
const MEDIA_FILE_EXTENSIONS = /\.(mp4|m4v|webm|mov|mkv)$/i;

async function fetchText(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Ищем в мастер-плейлисте вариант с указанным именем файла и возвращаем его разрешение
function findVariantResolution(masterContent, mediaFilename) {
  const lines = masterContent.split('\n').map(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    // Следующая непустая строка без # — URI варианта
    for (let j = i + 1; j < lines.length; j++) {
      const uriLine = lines[j];
      if (!uriLine) continue;
      if (uriLine.startsWith('#')) break;
      const uriFilename = uriLine.split('?')[0].split('/').pop();
      if (uriFilename === mediaFilename) {
        const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
        return resMatch ? resMatch[1] : null;
      }
      break;
    }
  }
  return null;
}

// Если URL указывает на медиа-плейлист (конкретное качество без информации о разрешении),
// пробуем найти мастер-плейлист в той же директории с теми же query-параметрами.
// Возвращает { masterUrl, variantResolution } — разрешение именно того варианта,
// на который указывает исходный URL (или null, если вариант не найден в мастере)
async function findMasterPlaylist(url, prefetchedContent) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return null;
  }
  const filename = parsed.pathname.split('/').pop();
  if (!filename || !filename.endsWith('.m3u8')) return null;

  const content = prefetchedContent !== undefined ? prefetchedContent : await fetchText(url);
  if (!content || !content.trimStart().startsWith('#EXTM3U')) return null;
  if (content.includes('#EXT-X-STREAM-INF')) {
    // Это уже мастер-плейлист
    return null;
  }
  await log(`URL is a media playlist, probing for master playlist: ${url}`);

  const dirPath = parsed.pathname.slice(0, parsed.pathname.length - filename.length);
  for (const name of MASTER_PLAYLIST_NAMES) {
    if (name === filename) continue;
    const candidate = new URL(url);
    candidate.pathname = dirPath + name;
    const candidateUrl = candidate.toString();
    const candidateContent = await fetchText(candidateUrl);
    if (candidateContent && candidateContent.trimStart().startsWith('#EXTM3U') && candidateContent.includes('#EXT-X-STREAM-INF')) {
      const variantResolution = findVariantResolution(candidateContent, filename);
      await log(`Master playlist found: ${candidateUrl}, variant ${filename} resolution: ${variantResolution}`);
      return { masterUrl: candidateUrl, content: candidateContent, variantResolution };
    }
  }
  await log('Master playlist not found');
  return null;
}

// Суммарная длительность VOD-медиаплейлиста в секундах (сумма #EXTINF)
function parseHlsDuration(content) {
  let total = 0;
  let found = false;
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*#EXTINF:\s*([\d.]+)/);
    if (m) {
      total += parseFloat(m[1]);
      found = true;
    }
  }
  return found ? total : null;
}

// Варианты мастер-плейлиста: разрешение, битрейт и URI
function parseMasterVariants(content) {
  const lines = content.split('\n').map(l => l.trim());
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const uriLine = lines[j];
      if (!uriLine) continue;
      if (uriLine.startsWith('#')) break;
      const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
      // AVERAGE-BANDWIDTH точнее для оценки размера, BANDWIDTH — пиковый
      const bwMatch = lines[i].match(/AVERAGE-BANDWIDTH=(\d+)/) || lines[i].match(/(?:^|[,:])BANDWIDTH=(\d+)/);
      const resolution = resMatch ? resMatch[1] : null;
      const [width, height] = resolution ? resolution.split('x').map(Number) : [0, 0];
      variants.push({
        uri: uriLine,
        resolution,
        pixels: width * height,
        bandwidth: bwMatch ? parseInt(bwMatch[1]) : null
      });
      break;
    }
  }
  return variants;
}

// Длительность HLS (из медиа-плейлиста) и битрейт варианта (из мастер-плейлиста).
// Нужно потому, что для части CDN yt-dlp не сообщает ни длительность, ни размер
async function getHlsMeta(url, content, masterUrl, masterContent, targetResolution) {
  let variant = null;
  if (masterContent) {
    const variants = parseMasterVariants(masterContent);
    variant = variants.find(v => v.resolution === targetResolution)
      || variants.slice().sort((a, b) => b.pixels - a.pixels)[0]
      || null;
  }

  // Если проверяемый URL — сам мастер, длительность меряем по его варианту
  let mediaContent = content;
  if (masterUrl === url) {
    mediaContent = variant ? await fetchText(new URL(variant.uri, url).toString()) : null;
  }

  return {
    duration: mediaContent ? parseHlsDuration(mediaContent) : null,
    bandwidth: variant ? variant.bandwidth : null
  };
}

// Длительность ISO 8601 из MPD: PT1H25M30.5S
function parseIso8601Duration(value) {
  const m = value.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return null;
  const [, d, h, min, s] = m;
  const total = (parseFloat(d || 0) * 86400) + (parseFloat(h || 0) * 3600) + (parseFloat(min || 0) * 60) + parseFloat(s || 0);
  return total > 0 ? total : null;
}

// Длительность и битрейт нужного представления из DASH-манифеста
async function getDashMeta(url, targetResolution) {
  const xml = await fetchText(url);
  if (!xml || !xml.includes('<MPD')) return null;

  const durMatch = xml.match(/mediaPresentationDuration="([^"]+)"/);
  const duration = durMatch ? parseIso8601Duration(durMatch[1]) : null;

  // Representation с width/height — видеодорожки; аудио идёт отдельно,
  // поэтому к битрейту видео добавляем лучшую аудиодорожку
  const reps = [];
  for (const tag of xml.match(/<Representation\b[^>]*>/g) || []) {
    const bwMatch = tag.match(/\bbandwidth="(\d+)"/);
    if (!bwMatch) continue;
    const wMatch = tag.match(/\bwidth="(\d+)"/);
    const hMatch = tag.match(/\bheight="(\d+)"/);
    reps.push({
      bandwidth: parseInt(bwMatch[1]),
      resolution: wMatch && hMatch ? `${wMatch[1]}x${hMatch[1]}` : null,
      pixels: wMatch && hMatch ? parseInt(wMatch[1]) * parseInt(hMatch[1]) : 0
    });
  }

  const videoReps = reps.filter(r => r.resolution);
  const video = videoReps.find(r => r.resolution === targetResolution)
    || videoReps.slice().sort((a, b) => b.pixels - a.pixels)[0]
    || null;
  const audioBandwidths = reps.filter(r => !r.resolution).map(r => r.bandwidth);
  const audio = audioBandwidths.length ? Math.max(...audioBandwidths) : 0;

  // @bandwidth в MPD — пиковый, оценка по нему завышена в полтора раза.
  // Рядом обычно лежит HLS-мастер (Cloudflare Stream отдаёт оба) с
  // AVERAGE-BANDWIDTH — он даёт оценку с точностью до пары процентов
  const hlsBandwidth = await findSiblingHlsBandwidth(url, targetResolution);
  const bandwidth = hlsBandwidth || (video ? video.bandwidth + audio : null);

  return { duration, bandwidth };
}

// Средний битрейт нужного варианта из HLS-мастера, лежащего рядом с манифестом
async function findSiblingHlsBandwidth(url, targetResolution) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return null;
  }
  const dirPath = parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1);
  for (const name of MASTER_PLAYLIST_NAMES) {
    const candidate = new URL(url);
    candidate.pathname = dirPath + name;
    const content = await fetchText(candidate.toString());
    if (!content || !content.includes('#EXT-X-STREAM-INF')) continue;
    const variants = parseMasterVariants(content);
    const variant = variants.find(v => v.resolution === targetResolution)
      || variants.slice().sort((a, b) => b.pixels - a.pixels)[0];
    if (variant && variant.bandwidth) {
      await log(`Bandwidth from sibling HLS master ${candidate.toString()}: ${variant.bandwidth}`);
      return variant.bandwidth;
    }
  }
  return null;
}

function formatDuration(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Пытаемся угадать разрешение по паттерну в URL (например, "1080p", "720p")
function guessResolutionFromUrl(url) {
  const heightMatch = url.match(/(\d{3,4})p(?:[_./?\s]|$)/i);
  if (!heightMatch) return null;
  const height = parseInt(heightMatch[1]);
  const knownResolutions = {
    2160: '3840x2160',
    1440: '2560x1440',
    1080: '1920x1080',
    720: '1280x720',
    480: '854x480',
    360: '640x360',
    240: '426x240',
    144: '256x144',
  };
  const resolution = knownResolutions[height];
  return resolution ? `${resolution} (?)` : `${height}p (?)`;
}

async function parseYtDlpOutput(output, url, targetResolution) {
  const lines = output.split('\n');

  // Ищем строки с разрешением (формат: ID EXT RESOLUTION ...)
  // Пример: 6864 mp4 1920x1080   24 │ ~1.68GiB 6864k m3u8  │ avc1.640032 mp4a.40.2
  const resolutionRegex = /(\d+x\d+)/;
  // Поддержка размеров с ~ и пробелами: ~1.03GiB, ~ 1.03 GiB, 893.69MiB
  const filesizeRegex = /~?\s*[\d.]+\s*(?:B|KiB|MiB|GiB|TiB)/i;

  let bestFormatId = null;
  let bestResolution = null;
  let bestFilesize = null;
  let bestVideoOnly = false;
  let maxPixels = 0;
  let fallbackFormatId = null;
  let targetMatched = false;

  await log(`Parsing yt-dlp output, total lines: ${lines.length}${targetResolution ? `, target resolution: ${targetResolution}` : ''}`);

  for (const line of lines) {
    // Ищем ID формата в начале строки: обычно число, но для прямых файлов
    // yt-dlp дает нечисловые ID (например, "mp4")
    const formatIdMatch = line.match(/^([A-Za-z0-9._-]+)\s+/);
    if (!formatIdMatch) continue;

    const formatId = formatIdMatch[1];
    // Пропускаем строку заголовка таблицы ("ID EXT RESOLUTION ...")
    if (formatId === 'ID') continue;

    const resMatch = line.match(resolutionRegex);
    if (resMatch) {
      const resolution = resMatch[1];
      const [width, height] = resolution.split('x').map(Number);
      const pixels = width * height;

      // Ищем размер файла в этой же строке
      const sizeMatch = line.match(filesizeRegex);

      await log(`Found resolution: ${resolution}, formatId: ${formatId}, filesize: ${sizeMatch ? sizeMatch[0] : 'not found'}, line: ${line}`);

      // Если задано целевое разрешение (конкретный вариант из мастер-плейлиста) —
      // выбираем именно его, иначе максимальное по пикселям
      // Формат без звука (аудио отдельной дорожкой) — колонка ACODEC = "video only"
      const videoOnly = /\bvideo only\b/i.test(line);

      if (targetResolution && resolution === targetResolution && !targetMatched) {
        targetMatched = true;
        bestFormatId = formatId;
        bestResolution = resolution;
        bestVideoOnly = videoOnly;
        bestFilesize = sizeMatch ? sizeMatch[0].trim().replace(/\s+/g, '') : null;
      } else if (!targetMatched && pixels > maxPixels) {
        maxPixels = pixels;
        bestFormatId = formatId;
        bestResolution = resolution;
        bestVideoOnly = videoOnly;
        bestFilesize = sizeMatch ? sizeMatch[0].trim().replace(/\s+/g, '') : null;
      }
    } else {
      // Формат без разрешения (например, HLS с "unknown") — запоминаем как fallback
      if (!fallbackFormatId) {
        fallbackFormatId = formatId;
        await log(`Found format without resolution (fallback): formatId=${formatId}, line: ${line}`);
      }
    }
  }

  if (bestResolution) {
    // У формата нет звука — просим yt-dlp домешать лучшую аудиодорожку
    // (запасной вариант после "/" — на случай, если аудио у видео вовсе нет)
    const selector = bestVideoOnly ? `${bestFormatId}+bestaudio/${bestFormatId}` : bestFormatId;
    await log(`Best format selected: id=${selector}, resolution=${bestResolution}, filesize=${bestFilesize}, videoOnly=${bestVideoOnly}`);
    return {
      success: true,
      formatId: selector,
      resolution: bestResolution,
      filesize: bestFilesize || null
    };
  }

  // Fallback: формат найден, но разрешение неизвестно (типично для HLS)
  if (fallbackFormatId) {
    const guessedResolution = url ? guessResolutionFromUrl(url) : null;
    const resolution = guessedResolution || 'unknown';
    await log(`Using fallback format: id=${fallbackFormatId}, resolution=${resolution}`);
    return {
      success: true,
      formatId: fallbackFormatId,
      resolution,
      filesize: null
    };
  }

  await log('No formats found in output');
  return {
    success: false,
    error: 'Видеопоток не найден'
  };
}

(async function main() {
  await log('Native host started');
  for (;;) {
    try {
      await log('Waiting for message...');
      const msg = await readMessage();
      await log('Message received, processing...');
      const resp = await handleMessage(msg);
      await log('Sending response...');
      writeMessage(resp);
      await log('Response sent');
    } catch (e) {
      await log(`Fatal error: ${e?.message || String(e)}`);
      writeMessage({ ok: false, error: 'fatal: ' + (e?.message || String(e)) });
      process.exit(0);
    }
  }
})();