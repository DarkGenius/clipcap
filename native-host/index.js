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
        const result = await parseYtDlpOutput(stdout);
        await log(`Parse result: success=${result.success}, resolution=${result.resolution}, filesize=${result.filesize}`);

        const response = {
          ok: true,
          kind: 'ytdlp-check',
          type: 'ytdlp-check-result',
          url: url,
          success: result.success,
          formatId: result.formatId,
          resolution: result.resolution,
          filesize: result.filesize,
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
      const { ytdlpPath, formatId, url, outputPath, filename } = msg;
      await log(`YT-DLP download: formatId=${formatId}, url=${url}, output=${outputPath}/${filename}`);

      try {
        const fullPath = join(outputPath, filename);
        // Добавляем --newline для корректного вывода прогресса и --no-warnings чтобы игнорировать предупреждения
        const args = ['-f', formatId, url, '-o', fullPath, '--newline', '--no-warnings'];

        await log(`Spawning yt-dlp: ${ytdlpPath} ${args.join(' ')}`);

        // Используем spawn для получения потокового вывода
        const child = spawn(ytdlpPath, args);

        // Сохраняем процесс для возможности отмены
        downloadProcesses.set(url, child);

        child.stdout.on('data', (data) => {
          const output = data.toString();
          // Убираем управляющие символы (например, \r) которые могут мешать парсингу
          const cleanOutput = output.replace(/\r/g, '\n').trim();
          log(`YT-DLP stdout: ${cleanOutput}`);

          // Парсим прогресс из вывода yt-dlp
          // Пример: [download]  45.0% of 1.68GiB at 5.21MiB/s ETA 02:35
          // Пример с фрагментами: [download]   8.3% of ~   1.49GiB at    2.92MiB/s ETA 07:55 (frag 39/457)
          const progressMatch = cleanOutput.match(/\[download\]\s+([\d.]+)%/);
          if (progressMatch) {
            const percent = parseFloat(progressMatch[1]);
            // Отправляем обновление прогресса
            writeMessage({
              type: 'ytdlp-download-progress',
              url: url,
              percent: percent,
              output: cleanOutput
            });
          }
        });

        child.stderr.on('data', (data) => {
          const output = data.toString();
          // Убираем управляющие символы (например, \r) которые могут мешать парсингу
          const cleanOutput = output.replace(/\r/g, '\n').trim();
          log(`YT-DLP stderr: ${cleanOutput}`);

          // yt-dlp может выводить прогресс в stderr
          const progressMatch = cleanOutput.match(/\[download\]\s+([\d.]+)%/);
          if (progressMatch) {
            const percent = parseFloat(progressMatch[1]);
            writeMessage({
              type: 'ytdlp-download-progress',
              url: url,
              percent: percent,
              output: cleanOutput
            });
          }
        });

        child.on('close', async (code) => {
          await log(`YT-DLP download finished with code: ${code}`);
          downloadProcesses.delete(url);

          if (code === 0) {
            writeMessage({
              type: 'ytdlp-download-complete',
              url: url,
              success: true,
              filepath: fullPath
            });
          } else if (code === null) {
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
              error: `Ошибка загрузки (код: ${code})`
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
    if (msg.type === 'host:ytdlp-cancel') {
      const { url } = msg;
      await log(`YT-DLP cancel download: url=${url}`);

      const child = downloadProcesses.get(url);
      if (child) {
        await log(`Killing process for ${url}`);
        child.kill('SIGTERM');
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

async function parseYtDlpOutput(output) {
  const lines = output.split('\n');

  // Ищем строки с разрешением (формат: ID EXT RESOLUTION ...)
  // Пример: 6864 mp4 1920x1080   24 │ ~1.68GiB 6864k m3u8  │ avc1.640032 mp4a.40.2
  const resolutionRegex = /(\d+x\d+)/;
  // Поддержка размеров с ~ и пробелами: ~1.03GiB, ~ 1.03 GiB, 893.69MiB
  const filesizeRegex = /~?\s*[\d.]+\s*(?:B|KiB|MiB|GiB|TiB)/i;

  let bestFormatId = null;
  let bestResolution = null;
  let bestFilesize = null;
  let maxPixels = 0;

  await log(`Parsing yt-dlp output, total lines: ${lines.length}`);

  for (const line of lines) {
    const resMatch = line.match(resolutionRegex);
    if (resMatch) {
      const resolution = resMatch[1];
      const [width, height] = resolution.split('x').map(Number);
      const pixels = width * height;

      // Ищем ID формата в начале строки (первое число)
      const formatIdMatch = line.match(/^(\d+)\s+/);
      const formatId = formatIdMatch ? formatIdMatch[1] : null;

      // Ищем размер файла в этой же строке
      const sizeMatch = line.match(filesizeRegex);

      await log(`Found resolution: ${resolution}, formatId: ${formatId}, filesize: ${sizeMatch ? sizeMatch[0] : 'not found'}, line: ${line}`);

      // Выбираем максимальное разрешение
      if (pixels > maxPixels) {
        maxPixels = pixels;
        bestFormatId = formatId;
        bestResolution = resolution;
        bestFilesize = sizeMatch ? sizeMatch[0].trim() : null;
      }
    }
  }

  if (bestResolution) {
    await log(`Best format selected: id=${bestFormatId}, resolution=${bestResolution}, filesize=${bestFilesize}`);
    return {
      success: true,
      formatId: bestFormatId,
      resolution: bestResolution,
      filesize: bestFilesize || 'неизвестен'
    };
  }

  await log('No resolution found in output');
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