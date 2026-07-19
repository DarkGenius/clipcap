const logEl = document.getElementById('log');
const btnRefreshM3u8 = document.getElementById('btn-refresh-m3u8');
const btnClearM3u8 = document.getElementById('btn-clear-m3u8');
const m3u8ListEl = document.getElementById('m3u8-list');
const m3u8CountEl = document.getElementById('m3u8-count');
const currentPageEl = document.getElementById('current-page');
const ytdlpPathInput = document.getElementById('ytdlp-path');
const ytdlpOutputInput = document.getElementById('ytdlp-output');
const showQueryParamsInput = document.getElementById('show-query-params');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnClearLog = document.getElementById('btn-clear-log');
const btnOpenSettings = document.getElementById('btn-open-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const settingsModal = document.getElementById('settings-modal');
const btnToggleLogs = document.getElementById('btn-toggle-logs');
const logsContent = document.getElementById('logs-content');
const downloadsListEl = document.getElementById('downloads-list');
const activeDownloadsCountEl = document.getElementById('active-downloads-count');
const btnRefreshDownloads = document.getElementById('btn-refresh-downloads');

// Значения по умолчанию
const DEFAULT_SETTINGS = {
  ytdlpPath: 'E:\\yt-dlp\\yt-dlp.exe',
  ytdlpOutput: 'E:\\yt-dlp',
  showQueryParams: false
};

let currentSettings = { ...DEFAULT_SETTINGS };

function stripQueryParams(url) {
  if (!url) return url;
  const i = url.indexOf('?');
  return i === -1 ? url : url.substring(0, i);
}

function displayUrl(url) {
  return currentSettings.showQueryParams ? url : stripQueryParams(url);
}

// Хранилище для обратных вызовов проверки URL
const pendingChecks = new Map();

// Кэш последнего сохранённого размера файла (чтобы не писать в storage на каждый прогресс)
const lastSavedFilesize = new Map();

// Ключ для хранения активных загрузок
const ACTIVE_DOWNLOADS_KEY = 'activeDownloads';
// Ключ для хранения завершенных загрузок
const COMPLETED_DOWNLOADS_KEY = 'completedDownloads';
// Ключ для хранения прерванных загрузок (хост перезапустился, процесс погиб)
const INTERRUPTED_DOWNLOADS_KEY = 'interruptedDownloads';

function log(msg) {
  logEl.textContent += (typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2)) + '\n';
}

// Персистентный лог событий, который пишет background.js (ошибки yt-dlp,
// завершения загрузок и т.п.) — доступен даже если попап был закрыт
const UI_LOGS_KEY = 'uiLogs';
let lastUiLogSeq = 0;

function formatUiLogEntry(entry) {
  const t = new Date(entry.time);
  const pad = (n) => String(n).padStart(2, '0');
  return `[${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}] ${entry.text}`;
}

async function loadUiLogs() {
  const result = await chrome.storage.local.get([UI_LOGS_KEY]);
  const logs = result[UI_LOGS_KEY] || [];
  for (const entry of logs) {
    log(formatUiLogEntry(entry));
  }
  lastUiLogSeq = logs.length ? logs[logs.length - 1].seq || 0 : 0;
}

// Живое обновление: background дописывает события в storage, попап их дорисовывает
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[UI_LOGS_KEY]) return;
  const logs = changes[UI_LOGS_KEY].newValue || [];
  for (const entry of logs) {
    if ((entry.seq || 0) > lastUiLogSeq) {
      log(formatUiLogEntry(entry));
      lastUiLogSeq = entry.seq || 0;
    }
  }
});

async function ensureConnect() {
  await chrome.runtime.sendMessage({ type: 'ensure-connect' });
}

// Сохраняем результат проверки в объект URL
async function saveCheckResult(url, result) {
  const response = await chrome.runtime.sendMessage({ type: 'get-m3u8-urls' });
  const allUrls = response.urls || [];

  // Находим URL и добавляем результат проверки
  const updatedUrls = allUrls.map(item => {
    if (item.url === url) {
      return {
        ...item,
        checkResult: {
          success: result.success,
          formatId: result.formatId,
          resolution: result.resolution,
          filesize: result.filesize || null,
          unknownFilesize: !result.filesize,
          downloadUrl: result.downloadUrl || null,
          error: result.error,
          checkedAt: new Date().toISOString()
        }
      };
    }
    return item;
  });

  // Сохраняем обратно
  await chrome.storage.local.set({ m3u8Urls: updatedUrls });
}

async function updateCheckResultFilesize(url, filesize) {
  const result = await chrome.storage.local.get(['m3u8Urls']);
  const allUrls = result.m3u8Urls || [];
  for (const item of allUrls) {
    if (item.url === url && item.checkResult && item.checkResult.unknownFilesize) {
      item.checkResult.filesize = filesize;
      await chrome.storage.local.set({ m3u8Urls: allUrls });
      break;
    }
  }
}

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg?.source === 'native-host') {
    // Обработка ответа от yt-dlp проверки
    if (msg.payload?.type === 'ytdlp-check-result') {
      const { url, success, formatId, resolution, filesize, downloadUrl, error } = msg.payload;

      const result = { success, formatId, resolution, filesize, downloadUrl, error };

      // Сохраняем результат в storage
      await saveCheckResult(url, result);

      // Вызываем обратный вызов, если он есть
      if (pendingChecks.has(url)) {
        const callback = pendingChecks.get(url);
        callback(result);
        pendingChecks.delete(url);
      }

      // Также обновляем UI напрямую (для надежности)
      const btn = document.querySelector(`.check-btn[data-url="${escapeHtml(url)}"]`);
      if (btn) {
        const container = btn.parentElement.querySelector('.info-container');
        btn.disabled = false;
        btn.textContent = 'Перепроверить';

        if (success && resolution) {
          container.innerHTML = `<div class="info success">Разрешение: ${resolution}, Размер: ${filesize || 'неизвестен'}</div>`;
          // Обновляем флаг unknownFilesize на родительском элементе
          const m3u8Item = btn.closest('.m3u8-item');
          if (m3u8Item) m3u8Item.dataset.unknownFilesize = filesize ? 'false' : 'true';
          // Добавляем кнопку "Скачать" если ее еще нет
          const existingDownloadBtn = btn.parentElement.querySelector('.download-btn');
          if (!existingDownloadBtn) {
            const downloadBtn = document.createElement('button');
            downloadBtn.className = 'download-btn';
            downloadBtn.textContent = 'Скачать';
            downloadBtn.setAttribute('data-url', url);
            downloadBtn.setAttribute('data-formatid', formatId || '');
            downloadBtn.setAttribute('data-resolution', resolution);
            downloadBtn.setAttribute('data-download-url', downloadUrl || '');
            downloadBtn.addEventListener('click', async (e) => {
              await downloadM3u8(url, formatId, resolution, e.target, downloadUrl);
            });
            btn.parentElement.insertBefore(downloadBtn, btn.nextSibling);
          }
        } else {
          container.innerHTML = `<div class="info error">${error || 'Видеопоток не найден'}</div>`;
        }
      }
    }

    // Обработка прогресса загрузки
    if (msg.payload?.type === 'ytdlp-download-progress') {
      const { url, percent, filesize } = msg.payload;

      // Ищем кнопку среди всех кнопок "Скачать"
      const allDownloadBtns = document.querySelectorAll('.download-btn');
      let downloadBtn = null;
      for (const btn of allDownloadBtns) {
        if (btn.getAttribute('data-url') === url) {
          downloadBtn = btn;
          break;
        }
      }

      if (downloadBtn) {
        const progressFill = downloadBtn.parentElement.querySelector('.progress-fill');
        const progressText = downloadBtn.parentElement.querySelector('.progress-text');
        if (progressFill && progressText) {
          progressFill.style.width = `${percent}%`;
          progressText.textContent = `${percent.toFixed(1)}%`;
        }
      }

      // Обновляем размер файла в info-блоке только если он был неизвестен при проверке
      if (filesize) {
        const m3u8Item = document.querySelector(`.m3u8-item[data-url="${CSS.escape(url)}"]`);
        if (m3u8Item && m3u8Item.dataset.unknownFilesize === 'true') {
          const filesizeDisplay = '~' + filesize;
          const infoEl = m3u8Item.querySelector('.info.success');
          if (infoEl) {
            infoEl.textContent = infoEl.textContent.replace(/Размер: \S+/, 'Размер: ' + filesizeDisplay);
          }
          if (lastSavedFilesize.get(url) !== filesizeDisplay) {
            lastSavedFilesize.set(url, filesizeDisplay);
            await updateCheckResultFilesize(url, filesizeDisplay);
          }
        }
      }

      // Обновляем процент в storage
      const activeDownloads = await getActiveDownloads();
      if (activeDownloads[url]) {
        activeDownloads[url].percent = percent;
        await chrome.storage.local.set({ [ACTIVE_DOWNLOADS_KEY]: activeDownloads });
      }

      // Обновляем вкладку "Загрузки" если она открыта
      const downloadsTab = document.querySelector('.tab-btn[data-tab="downloads"]');
      if (downloadsTab && downloadsTab.classList.contains('active')) {
        // Обновляем только прогресс-бар для конкретной загрузки
        const allDownloadItems = downloadsListEl.querySelectorAll('.download-item');
        for (const item of allDownloadItems) {
          if (item.getAttribute('data-url') === url) {
            const progressFill = item.querySelector('.progress-fill');
            const progressText = item.querySelector('.progress-text');
            if (progressFill && progressText) {
              progressFill.style.width = `${percent}%`;
              progressText.textContent = `${percent.toFixed(1)}%`;
            }
            break;
          }
        }
      }
    }

    // Обработка завершения загрузки
    if (msg.payload?.type === 'ytdlp-download-complete') {
      const { url, success, filepath, error } = msg.payload;

      // Ищем кнопку среди всех кнопок "Скачать"
      const allDownloadBtns = document.querySelectorAll('.download-btn');
      let downloadBtn = null;
      for (const btn of allDownloadBtns) {
        if (btn.getAttribute('data-url') === url) {
          downloadBtn = btn;
          break;
        }
      }

      if (downloadBtn) {
        const progressContainer = downloadBtn.parentElement.querySelector('.progress-container');

        if (success) {
          // При успешной загрузке скрываем кнопку "Скачать" и показываем статус
          progressContainer.innerHTML = `<div class="info success">✓ Загружено: ${filepath}</div>`;
          downloadBtn.style.display = 'none';
        } else {
          // При ошибке показываем сообщение и разрешаем повторную попытку
          progressContainer.innerHTML = `<div class="info error">${error || 'Ошибка загрузки'}</div>`;
          downloadBtn.disabled = false;
        }
      }

      // Получаем данные активной загрузки перед удалением
      const activeDownloads = await getActiveDownloads();
      const downloadData = activeDownloads[url];

      // Удаляем из активных загрузок
      await removeActiveDownload(url);

      // Если загрузка успешна, сохраняем в завершенные
      if (success && downloadData) {
        await saveCompletedDownload(url, {
          ...downloadData,
          filepath: filepath,
          success: true
        });
      }

      // Обновляем счетчик активных загрузок
      const updatedActiveDownloads = await getActiveDownloads();
      activeDownloadsCountEl.textContent = Object.keys(updatedActiveDownloads).length;

      // Если вкладка "Загрузки" открыта, обновляем список
      const downloadsTab = document.querySelector('.tab-btn[data-tab="downloads"]');
      if (downloadsTab && downloadsTab.classList.contains('active')) {
        await loadDownloads();
      }
    }
  }
});

// Функции для работы с настройками
async function loadSettings() {
  const result = await chrome.storage.local.get(['ytdlpSettings']);
  const settings = { ...DEFAULT_SETTINGS, ...(result.ytdlpSettings || {}) };
  ytdlpPathInput.value = settings.ytdlpPath || DEFAULT_SETTINGS.ytdlpPath;
  ytdlpOutputInput.value = settings.ytdlpOutput || DEFAULT_SETTINGS.ytdlpOutput;
  showQueryParamsInput.checked = !!settings.showQueryParams;
  currentSettings = settings;
  return settings;
}

async function saveSettings() {
  const settings = {
    ytdlpPath: ytdlpPathInput.value || DEFAULT_SETTINGS.ytdlpPath,
    ytdlpOutput: ytdlpOutputInput.value || DEFAULT_SETTINGS.ytdlpOutput,
    showQueryParams: !!showQueryParamsInput.checked
  };
  await chrome.storage.local.set({ ytdlpSettings: settings });
  currentSettings = settings;

  // Визуальная обратная связь
  const originalText = btnSaveSettings.textContent;
  btnSaveSettings.textContent = '✓ Сохранено';
  btnSaveSettings.style.background = '#e8f5e9';
  setTimeout(() => {
    btnSaveSettings.textContent = originalText;
    btnSaveSettings.style.background = '';
  }, 1500);

  await loadM3u8Urls();
  await loadDownloads();
}

// Восстановить UI для активной загрузки
function restoreDownloadUI(url, downloadData) {
  // Ищем кнопку среди всех кнопок "Скачать"
  const allDownloadBtns = document.querySelectorAll('.download-btn');
  let downloadBtn = null;

  for (const btn of allDownloadBtns) {
    if (btn.getAttribute('data-url') === url) {
      downloadBtn = btn;
      break;
    }
  }

  if (!downloadBtn) {
    log(`ВНИМАНИЕ: Не удалось восстановить UI - кнопка не найдена для URL: ${url}`);
    return;
  }

  const progressContainer = downloadBtn.parentElement.querySelector('.progress-container');
  if (!progressContainer) {
    log(`ВНИМАНИЕ: progress-container не найден`);
    return;
  }

  downloadBtn.disabled = true;

  // Скрываем кнопки "Проверить" и "Скачать"
  const checkBtn = downloadBtn.parentElement.querySelector('.check-btn');
  if (checkBtn) checkBtn.style.display = 'none';
  if (downloadBtn) downloadBtn.style.display = 'none';

  // Показываем прогресс-бар с кнопкой отмены
  progressContainer.innerHTML = `
    <div class="progress">
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${downloadData.percent || 0}%"></div>
        <div class="progress-text">${(downloadData.percent || 0).toFixed(1)}%</div>
      </div>
      <button class="cancel-btn" data-url="${escapeHtml(url)}">Отменить</button>
    </div>
  `;

  // Добавляем обработчик для кнопки отмены
  const cancelBtn = progressContainer.querySelector('.cancel-btn');
  cancelBtn.addEventListener('click', async () => {
    await cancelDownload(url, cancelBtn);
  });

  log(`Восстановлен UI для загрузки: ${(downloadData.percent || 0).toFixed(1)}%`);
}

// Функции для работы с .m3u8 URL
async function loadM3u8Urls() {
  // Получаем текущую активную вкладку
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentPageUrl = currentTab?.url;

  // Обновляем отображение текущей страницы
  if (currentPageUrl) {
    // Показываем только домен и путь для экономии места
    try {
      const urlObj = new URL(currentPageUrl);
      currentPageEl.textContent = urlObj.hostname + urlObj.pathname;
      currentPageEl.title = currentPageUrl; // Полный URL в подсказке
    } catch {
      currentPageEl.textContent = currentPageUrl;
    }
  } else {
    currentPageEl.textContent = 'неизвестно';
  }

  const response = await chrome.runtime.sendMessage({ type: 'get-m3u8-urls' });
  const allUrls = response.urls || [];

  // Фильтруем только URL с текущей страницы
  const urls = allUrls.filter(item => item.pageUrl === currentPageUrl);

  // Получаем активные загрузки
  const activeDownloads = await getActiveDownloads();

  if (Object.keys(activeDownloads).length > 0) {
    log(`Найдено активных загрузок: ${Object.keys(activeDownloads).length}`);
    for (const [url, data] of Object.entries(activeDownloads)) {
      log(`- ${url.substring(0, 80)}... (${data.percent}%)`);
    }
  }

  m3u8CountEl.textContent = urls.length;

  if (urls.length === 0) {
    m3u8ListEl.innerHTML = '<div class="empty-state">На этой странице не найдено видеозапросов (.m3u8 или прямых видеофайлов)</div>';
  } else {
    m3u8ListEl.innerHTML = urls
      .reverse() // Последние сверху
      .map((item, index) => {
        const date = new Date(item.timestamp);
        const timeStr = date.toLocaleTimeString('ru-RU');

        // Проверяем, есть ли сохраненный результат проверки
        const effectiveUrl = item.effectiveUrl || item.url;

        let infoHtml = '';
        let btnText = 'Проверить';
        let downloadBtn = '';
        if (item.checkResult) {
          btnText = 'Перепроверить';
          if (item.checkResult.success && item.checkResult.resolution) {
            infoHtml = `<div class="info success">Разрешение: ${item.checkResult.resolution}, Размер: ${item.checkResult.filesize || 'неизвестен'}</div>`;
            // Добавляем кнопку скачать если проверка успешна
            downloadBtn = `<button class="download-btn" data-url="${escapeHtml(item.url)}" data-formatid="${item.checkResult.formatId || ''}" data-resolution="${item.checkResult.resolution}" data-download-url="${escapeHtml(item.checkResult.downloadUrl || '')}">Скачать</button>`;
          } else {
            infoHtml = `<div class="info error">${item.checkResult.error || 'Видеопоток не найден'}</div>`;
          }
        }

        const unknownFilesize = item.checkResult?.unknownFilesize ? 'true' : 'false';

        const kindBadge = item.mediaKind === 'file' ? ' • Файл' : '';

        return `
          <div class="m3u8-item" data-index="${index}" data-url="${escapeHtml(item.url)}" data-unknown-filesize="${unknownFilesize}">
            <div class="url">${escapeHtml(displayUrl(effectiveUrl))}</div>
            <div class="time">${timeStr}${kindBadge}</div>
            <button class="check-btn" data-url="${escapeHtml(item.url)}">${btnText}</button>
            ${downloadBtn}
            <div class="info-container">${infoHtml}</div>
            <div class="progress-container"></div>
          </div>
        `;
      })
      .join('');

    // Добавляем обработчики для кнопок "Проверить"
    document.querySelectorAll('.check-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const url = e.target.getAttribute('data-url');
        await checkM3u8Url(url, e.target);
      });
    });

    // Добавляем обработчики для кнопок "Скачать"
    document.querySelectorAll('.download-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const url = e.target.getAttribute('data-url');
        const formatId = e.target.getAttribute('data-formatid');
        const resolution = e.target.getAttribute('data-resolution');
        const downloadUrl = e.target.getAttribute('data-download-url') || null;
        await downloadM3u8(url, formatId, resolution, e.target, downloadUrl);
      });
    });

    // Восстанавливаем UI для активных загрузок
    for (const [url, downloadData] of Object.entries(activeDownloads)) {
      restoreDownloadUI(url, downloadData);
    }
  }
}

async function checkM3u8Url(url, btnElement) {
  const container = btnElement.parentElement.querySelector('.info-container');
  container.innerHTML = '<div class="info">Проверка...</div>';
  btnElement.disabled = true;

  log(`Начало проверки URL: ${url}`);

  try {
    await ensureConnect();
    log('Соединение с хостом установлено');

    // Получаем настройки
    const settings = await loadSettings();
    log(`Настройки: ytdlpPath=${settings.ytdlpPath}`);

    // Очищаем старый результат из storage (если есть)
    await chrome.storage.local.remove([`ytdlp-result-${url}`]);

    // Создаем промис с таймаутом и проверкой storage
    const timeoutMs = 60000; // 60 секунд
    const checkPromise = new Promise((resolve, reject) => {
      // Сохраняем обратный вызов для сообщений
      pendingChecks.set(url, resolve);

      // Периодически проверяем storage на наличие результата
      const storageCheckInterval = setInterval(async () => {
        log('Проверка storage на наличие результата...');
        const storageKey = `ytdlp-result-${url}`;
        const result = await chrome.storage.local.get([storageKey]);

        if (result[storageKey]) {
          log('Результат найден в storage!');
          clearInterval(storageCheckInterval);
          if (pendingChecks.has(url)) {
            pendingChecks.delete(url);
          }
          resolve(result[storageKey]);
        }
      }, 500); // Проверяем каждые 500мс

      // Таймаут
      setTimeout(() => {
        clearInterval(storageCheckInterval);
        if (pendingChecks.has(url)) {
          pendingChecks.delete(url);
          reject(new Error('Таймаут проверки (60 сек)'));
        }
      }, timeoutMs);
    });

    // Отправляем команду на выполнение yt-dlp
    log('Отправка команды на хост...');
    const sendResult = await chrome.runtime.sendMessage({
      type: 'host:ytdlp-check',
      ytdlpPath: settings.ytdlpPath,
      url: url
    });
    log(`Команда отправлена: ${JSON.stringify(sendResult)}`);

    if (!sendResult || !sendResult.ok) {
      throw new Error('Не удалось отправить команду на хост: ' + (sendResult?.error || 'неизвестная ошибка'));
    }

    // Ждем ответа
    log('Ожидание ответа от хоста...');
    const result = await checkPromise;
    log(`Получен результат: ${JSON.stringify(result)}`);

    // Обновляем UI
    if (result.success && result.resolution) {
      container.innerHTML = `<div class="info success">Разрешение: ${result.resolution}, Размер: ${result.filesize || 'неизвестен'}</div>`;
      // Обновляем флаг unknownFilesize на родительском элементе
      const m3u8Item = btnElement.closest('.m3u8-item');
      if (m3u8Item) m3u8Item.dataset.unknownFilesize = result.filesize ? 'false' : 'true';

      // Добавляем кнопку "Скачать"
      const existingDownloadBtn = btnElement.parentElement.querySelector('.download-btn');
      if (!existingDownloadBtn) {
        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'download-btn';
        downloadBtn.textContent = 'Скачать';
        downloadBtn.setAttribute('data-url', url);
        downloadBtn.setAttribute('data-formatid', result.formatId || '');
        downloadBtn.setAttribute('data-resolution', result.resolution);
        downloadBtn.setAttribute('data-download-url', result.downloadUrl || '');
        downloadBtn.addEventListener('click', async (e) => {
          await downloadM3u8(url, result.formatId, result.resolution, e.target, result.downloadUrl);
        });
        btnElement.parentElement.insertBefore(downloadBtn, btnElement.nextSibling);
      }
    } else {
      container.innerHTML = `<div class="info error">${result.error || 'Видеопоток не найден'}</div>`;
    }
    btnElement.disabled = false;
    btnElement.textContent = 'Перепроверить';

    // Сохраняем результат в объект URL
    await saveCheckResult(url, result);

    // Очищаем результат из storage
    await chrome.storage.local.remove([`ytdlp-result-${url}`]);

  } catch (err) {
    log(`Ошибка проверки: ${err.message}`);
    container.innerHTML = `<div class="info error">Ошибка: ${err.message}</div>`;
    btnElement.disabled = false;
    pendingChecks.delete(url);
  }
}

// Сохранить активную загрузку
async function saveActiveDownload(url, data) {
  const result = await chrome.storage.local.get([ACTIVE_DOWNLOADS_KEY]);
  const activeDownloads = result[ACTIVE_DOWNLOADS_KEY] || {};
  activeDownloads[url] = {
    ...data,
    startedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [ACTIVE_DOWNLOADS_KEY]: activeDownloads });
}

// Удалить активную загрузку
async function removeActiveDownload(url) {
  const result = await chrome.storage.local.get([ACTIVE_DOWNLOADS_KEY]);
  const activeDownloads = result[ACTIVE_DOWNLOADS_KEY] || {};
  delete activeDownloads[url];
  await chrome.storage.local.set({ [ACTIVE_DOWNLOADS_KEY]: activeDownloads });
}

// Получить все активные загрузки
async function getActiveDownloads() {
  const result = await chrome.storage.local.get([ACTIVE_DOWNLOADS_KEY]);
  return result[ACTIVE_DOWNLOADS_KEY] || {};
}

// Сохранить завершенную загрузку
async function saveCompletedDownload(url, data) {
  const result = await chrome.storage.local.get([COMPLETED_DOWNLOADS_KEY]);
  const completedDownloads = result[COMPLETED_DOWNLOADS_KEY] || {};
  completedDownloads[url] = {
    ...data,
    completedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [COMPLETED_DOWNLOADS_KEY]: completedDownloads });
}

// Удалить завершенную загрузку
async function removeCompletedDownload(url) {
  const result = await chrome.storage.local.get([COMPLETED_DOWNLOADS_KEY]);
  const completedDownloads = result[COMPLETED_DOWNLOADS_KEY] || {};
  delete completedDownloads[url];
  await chrome.storage.local.set({ [COMPLETED_DOWNLOADS_KEY]: completedDownloads });
}

// Получить все завершенные загрузки
async function getCompletedDownloads() {
  const result = await chrome.storage.local.get([COMPLETED_DOWNLOADS_KEY]);
  return result[COMPLETED_DOWNLOADS_KEY] || {};
}

// Получить все прерванные загрузки
async function getInterruptedDownloads() {
  const result = await chrome.storage.local.get([INTERRUPTED_DOWNLOADS_KEY]);
  return result[INTERRUPTED_DOWNLOADS_KEY] || {};
}

// Удалить прерванную загрузку
async function removeInterruptedDownload(url) {
  const interrupted = await getInterruptedDownloads();
  delete interrupted[url];
  await chrome.storage.local.set({ [INTERRUPTED_DOWNLOADS_KEY]: interrupted });
}

// Запросить у хоста список реально идущих загрузок и перенести зависшие
// записи activeDownloads в interruptedDownloads. Возвращает число прерванных
async function invalidateStaleDownloads() {
  const activeDownloads = await getActiveDownloads();
  if (Object.keys(activeDownloads).length === 0) return 0;

  try {
    await ensureConnect();
    await chrome.storage.local.remove(['ytdlp-status-result']);

    const sendResult = await chrome.runtime.sendMessage({ type: 'host:ytdlp-status' });
    if (!sendResult || !sendResult.ok) {
      throw new Error(sendResult?.error || 'хост недоступен');
    }

    // Ждем результат в storage (background сохраняет его туда)
    let status = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 300));
      const result = await chrome.storage.local.get(['ytdlp-status-result']);
      if (result['ytdlp-status-result']) {
        status = result['ytdlp-status-result'];
        break;
      }
    }
    if (!status) {
      throw new Error('таймаут ожидания статуса от хоста');
    }
    await chrome.storage.local.remove(['ytdlp-status-result']);

    const reallyActive = new Set(status.activeUrls || []);
    const interrupted = await getInterruptedDownloads();
    let staleCount = 0;

    for (const [url, data] of Object.entries(activeDownloads)) {
      if (!reallyActive.has(url)) {
        interrupted[url] = {
          ...data,
          interruptedAt: new Date().toISOString()
        };
        delete activeDownloads[url];
        staleCount++;
        log(`Загрузка помечена как прерванная: ${url.substring(0, 80)}... (${data.percent || 0}%)`);
      }
    }

    if (staleCount > 0) {
      await chrome.storage.local.set({
        [ACTIVE_DOWNLOADS_KEY]: activeDownloads,
        [INTERRUPTED_DOWNLOADS_KEY]: interrupted
      });
    }
    return staleCount;
  } catch (err) {
    log(`Не удалось проверить статус загрузок: ${err.message}`);
    return 0;
  }
}

async function cancelDownload(url, cancelBtn) {
  try {
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Отмена...';

    await ensureConnect();

    // Отправляем команду на отмену загрузки
    const sendResult = await chrome.runtime.sendMessage({
      type: 'host:ytdlp-cancel',
      url: url
    });

    if (!sendResult || !sendResult.ok) {
      throw new Error('Не удалось отменить загрузку: ' + (sendResult?.error || 'неизвестная ошибка'));
    }

    // Удаляем из активных загрузок
    await removeActiveDownload(url);

  } catch (err) {
    log(`Ошибка отмены: ${err.message}`);
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Отменить';
  }
}

async function downloadM3u8(url, formatId, resolution, btnElement, downloadUrl) {
  const progressContainer = btnElement.parentElement.querySelector('.progress-container');
  const infoContainer = btnElement.parentElement.querySelector('.info-container');

  try {
    btnElement.disabled = true;

    // Скрываем кнопки "Проверить" и "Скачать"
    const checkBtn = btnElement.parentElement.querySelector('.check-btn');
    const downloadBtn = btnElement.parentElement.querySelector('.download-btn');
    if (checkBtn) checkBtn.style.display = 'none';
    if (downloadBtn) downloadBtn.style.display = 'none';

    // Получаем настройки
    const settings = await loadSettings();

    // Если для этого URL есть прерванная загрузка — используем то же имя файла,
    // чтобы yt-dlp продолжил с места обрыва, а не начал заново.
    // Ищем и по полному URL, и по URL без query: тот же файл мог быть
    // переобнаружен с новым токеном в query-параметрах
    const interrupted = await getInterruptedDownloads();
    let interruptedKey = interrupted[url] ? url : null;
    if (!interruptedKey) {
      const bareUrl = stripQueryParams(url);
      interruptedKey = Object.keys(interrupted).find(key => stripQueryParams(key) === bareUrl) || null;
    }
    let interruptedData = interruptedKey ? interrupted[interruptedKey] : null;
    // Подхватываем .part только если это тот же вариант качества:
    // фрагменты разных разрешений смешивать нельзя
    if (interruptedData?.resolution && resolution && interruptedData.resolution !== resolution) {
      log(`Прерванная запись пропущена: разрешение ${interruptedData.resolution} != ${resolution}`);
      interruptedKey = null;
      interruptedData = null;
    }
    let filename;
    if (interruptedData?.filename) {
      filename = interruptedData.filename;
      log(`Возобновление прерванной загрузки: ${filename} (с ${(interruptedData.percent || 0).toFixed(1)}%)`);
    } else {
      const timestamp = Date.now();
      // Для прямого видеофайла берем исходное имя из URL
      let srcName = '';
      try {
        srcName = new URL(url).pathname.split('/').pop() || '';
      } catch (e) {}
      const fileMatch = srcName.match(/^(.+)\.(mp4|m4v|webm|mov|mkv)$/i);
      if (fileMatch) {
        filename = `${fileMatch[1]}_${timestamp}.${fileMatch[2]}`;
      } else {
        // Генерируем имя файла
        const resolutionShort = resolution.includes('x') ? resolution.split('x')[1].replace(/\D+$/g, '') : resolution.replace(/\D+$/g, ''); // Берем только высоту (например, 1080 из 1920x1080)
        filename = `video_${resolutionShort}_${timestamp}.mp4`;
      }
    }

    // Показываем индикатор загрузки с кнопкой отмены
    progressContainer.innerHTML = `
      <div class="progress">
        <div class="progress-bar">
          <div class="progress-fill" style="width: 0%"></div>
          <div class="progress-text">0%</div>
        </div>
        <button class="cancel-btn" data-url="${escapeHtml(url)}">Отменить</button>
      </div>
    `;

    // Добавляем обработчик для кнопки отмены
    const cancelBtn = progressContainer.querySelector('.cancel-btn');
    cancelBtn.addEventListener('click', async () => {
      await cancelDownload(url, cancelBtn);
    });

    await ensureConnect();

    // Отправляем команду на загрузку
    const sendResult = await chrome.runtime.sendMessage({
      type: 'host:ytdlp-download',
      ytdlpPath: settings.ytdlpPath,
      formatId: formatId,
      url: url,
      downloadUrl: downloadUrl || undefined,
      outputPath: settings.ytdlpOutput,
      filename: filename
    });

    if (!sendResult || !sendResult.ok) {
      throw new Error('Не удалось запустить загрузку: ' + (sendResult?.error || 'неизвестная ошибка'));
    }

    // Загрузка стартовала — убираем запись из прерванных (если была)
    if (interruptedKey) {
      await removeInterruptedDownload(interruptedKey);
    }

    // Сохраняем активную загрузку в storage (downloadUrl — чтобы возобновление
    // использовало тот же URL, с которым согласован formatId)
    await saveActiveDownload(url, {
      formatId,
      resolution,
      filename,
      downloadUrl: downloadUrl || null,
      percent: interruptedData?.percent || 0
    });

    // Обновляем счетчик активных загрузок
    const activeDownloads = await getActiveDownloads();
    activeDownloadsCountEl.textContent = Object.keys(activeDownloads).length;

    // Прогресс будет обновляться через onMessage

  } catch (err) {
    log(`Ошибка загрузки: ${err.message}`);
    progressContainer.innerHTML = '';
    infoContainer.innerHTML = `<div class="info error">Ошибка загрузки: ${err.message}</div>`;
    btnElement.disabled = false;
    await removeActiveDownload(url);
  }
}

async function clearM3u8Urls() {
  // Получаем текущую активную вкладку
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentPageUrl = currentTab?.url;

  // Получаем все URL
  const response = await chrome.runtime.sendMessage({ type: 'get-m3u8-urls' });
  const allUrls = response.urls || [];

  // Оставляем только URL с других страниц
  const filteredUrls = allUrls.filter(item => item.pageUrl !== currentPageUrl);

  // Сохраняем обратно
  await chrome.storage.local.set({ m3u8Urls: filteredUrls });

  await loadM3u8Urls();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Функция для отображения активных загрузок
async function loadDownloads() {
  const activeDownloads = await getActiveDownloads();
  const completedDownloads = await getCompletedDownloads();
  const interruptedDownloads = await getInterruptedDownloads();
  const activeCount = Object.keys(activeDownloads).length;
  const completedCount = Object.keys(completedDownloads).length;
  const interruptedCount = Object.keys(interruptedDownloads).length;

  // Обновляем счетчик в заголовке вкладки (только активные)
  activeDownloadsCountEl.textContent = activeCount;

  if (activeCount === 0 && completedCount === 0 && interruptedCount === 0) {
    downloadsListEl.innerHTML = '<div class="empty-state">Нет загрузок</div>';
    return;
  }

  let downloadsHtml = '';

  // Формируем HTML для активных загрузок
  if (activeCount > 0) {
    downloadsHtml += '<div class="downloads-section"><h3>Активные загрузки</h3>';
    downloadsHtml += Object.entries(activeDownloads).map(([url, data], index) => {
      const shownUrl = displayUrl(url);
      const shortUrl = shownUrl.length > 80 ? shownUrl.substring(0, 80) + '...' : shownUrl;
      const percent = data.percent || 0;

      return `
        <div class="download-item active" data-url="${escapeHtml(url)}" data-index="${index}">
          <div class="url" title="${escapeHtml(shownUrl)}">${escapeHtml(shortUrl)}</div>
          <div class="filename">📁 ${escapeHtml(data.filename || 'video.mp4')} • ${data.resolution || 'неизвестно'}</div>
          <div class="progress">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${percent}%"></div>
              <div class="progress-text">${percent.toFixed(1)}%</div>
            </div>
            <button class="cancel-btn" data-url="${escapeHtml(url)}">Отменить</button>
          </div>
        </div>
      `;
    }).join('');
    downloadsHtml += '</div>';
  }

  // Формируем HTML для прерванных загрузок
  if (interruptedCount > 0) {
    downloadsHtml += '<div class="downloads-section"><h3>Прерванные загрузки</h3>';
    downloadsHtml += Object.entries(interruptedDownloads).map(([url, data], index) => {
      const shownUrl = displayUrl(url);
      const shortUrl = shownUrl.length > 80 ? shownUrl.substring(0, 80) + '...' : shownUrl;
      const percent = data.percent || 0;

      const lastErrorHtml = data.lastError
        ? `<div class="last-error">⚠ ${escapeHtml(data.lastError)}</div>`
        : '';

      return `
        <div class="download-item interrupted" data-url="${escapeHtml(url)}" data-index="${index}">
          <button class="remove-btn interrupted-remove-btn" data-url="${escapeHtml(url)}" title="Удалить из списка">×</button>
          <div class="url" title="${escapeHtml(shownUrl)}">${escapeHtml(shortUrl)}</div>
          <div class="filename">⏸ ${escapeHtml(data.filename || 'video.mp4')} • ${data.resolution || 'неизвестно'} • остановлена на ${percent.toFixed(1)}%</div>
          ${lastErrorHtml}
          <div class="completed-actions">
            <button class="resume-btn" data-url="${escapeHtml(url)}">Продолжить</button>
          </div>
        </div>
      `;
    }).join('');
    downloadsHtml += '</div>';
  }

  // Формируем HTML для завершенных загрузок
  if (completedCount > 0) {
    downloadsHtml += '<div class="downloads-section"><h3>Завершенные загрузки</h3>';
    downloadsHtml += Object.entries(completedDownloads).map(([url, data], index) => {
      const shownUrl = displayUrl(url);
      const shortUrl = shownUrl.length > 100 ? shownUrl.substring(0, 100) + '...' : shownUrl;
      const shortFilepath = data.filepath ? (data.filepath.length > 80 ? '...' + data.filepath.substring(data.filepath.length - 80) : data.filepath) : '';

      return `
        <div class="download-item completed" data-url="${escapeHtml(url)}" data-index="${index}">
          <button class="remove-btn" data-url="${escapeHtml(url)}" title="Удалить из списка">×</button>
          <div class="url" title="${escapeHtml(shownUrl)}">${escapeHtml(shortUrl)}</div>
          <div class="filename">✓ ${escapeHtml(data.filename || 'video.mp4')} • ${data.resolution || 'неизвестно'}</div>
          <div class="filepath" title="${escapeHtml(data.filepath || '')}">${escapeHtml(shortFilepath)}</div>
          <div class="completed-actions">
            <button class="open-btn" data-filepath="${escapeHtml(data.filepath || '')}">Открыть</button>
          </div>
        </div>
      `;
    }).join('');
    downloadsHtml += '</div>';
  }

  downloadsListEl.innerHTML = downloadsHtml;

  // Добавляем обработчики для кнопок отмены (активные загрузки)
  const cancelButtons = downloadsListEl.querySelectorAll('.cancel-btn');
  cancelButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = btn.getAttribute('data-url');
      await cancelDownloadFromList(url, btn);
    });
  });

  // Добавляем обработчики для кнопок удаления (завершенные загрузки)
  const removeButtons = downloadsListEl.querySelectorAll('.download-item.completed .remove-btn');
  removeButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = btn.getAttribute('data-url');
      await removeCompletedDownload(url);
      await loadDownloads(); // Обновляем список
    });
  });

  // Добавляем обработчики для кнопок удаления (прерванные загрузки)
  const interruptedRemoveButtons = downloadsListEl.querySelectorAll('.interrupted-remove-btn');
  interruptedRemoveButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = btn.getAttribute('data-url');
      await removeInterruptedDownload(url);
      await loadDownloads();
    });
  });

  // Добавляем обработчики для кнопок продолжения (прерванные загрузки)
  const resumeButtons = downloadsListEl.querySelectorAll('.resume-btn');
  resumeButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = btn.getAttribute('data-url');
      await resumeDownload(url, btn);
    });
  });

  // Добавляем обработчики для кнопок открытия (завершенные загрузки)
  const openButtons = downloadsListEl.querySelectorAll('.open-btn');
  openButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const filepath = btn.getAttribute('data-filepath');
      await openFile(filepath, btn);
    });
  });
}

// Возобновление прерванной загрузки: то же имя файла — yt-dlp продолжит
// с места обрыва по своим .part/.ytdl файлам
async function resumeDownload(url, btn) {
  const interrupted = await getInterruptedDownloads();
  const data = interrupted[url];
  if (!data || !data.filename) {
    log(`Нет данных для возобновления загрузки: ${url}`);
    return;
  }

  try {
    btn.disabled = true;
    btn.textContent = 'Запуск...';

    await ensureConnect();
    const settings = await loadSettings();

    // Используем downloadUrl из самой записи загрузки — он согласован с ее formatId.
    // Брать downloadUrl из свежего checkResult нельзя: formatId старой загрузки
    // может не существовать в мастер-плейлисте
    let downloadUrl = data.downloadUrl || undefined;
    if (!downloadUrl && data.formatId && data.formatId !== '0') {
      // Легаси-запись без downloadUrl: ненулевой formatId у m3u8-ссылок мог быть
      // получен только из мастер-плейлиста — восстанавливаем его из checkResult
      // (мастер-URL детерминирован: та же директория и query, что у исходного URL)
      const storageResult = await chrome.storage.local.get(['m3u8Urls']);
      const urlItem = (storageResult.m3u8Urls || []).find(item => item.url === url);
      downloadUrl = urlItem?.checkResult?.downloadUrl || undefined;
    }

    const sendResult = await chrome.runtime.sendMessage({
      type: 'host:ytdlp-download',
      ytdlpPath: settings.ytdlpPath,
      formatId: data.formatId,
      url: url,
      downloadUrl: downloadUrl,
      outputPath: settings.ytdlpOutput,
      filename: data.filename
    });

    if (!sendResult || !sendResult.ok) {
      throw new Error(sendResult?.error || 'неизвестная ошибка');
    }

    // Переносим из прерванных обратно в активные
    await removeInterruptedDownload(url);
    await saveActiveDownload(url, {
      formatId: data.formatId,
      resolution: data.resolution,
      filename: data.filename,
      downloadUrl: data.downloadUrl || null,
      percent: data.percent || 0
    });

    log(`Загрузка возобновлена: ${data.filename} (с ${(data.percent || 0).toFixed(1)}%)`);
    await loadDownloads();

  } catch (err) {
    log(`Ошибка возобновления: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Продолжить';
  }
}

// Отмена загрузки из списка загрузок
async function cancelDownloadFromList(url, cancelBtn) {
  try {
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Отмена...';

    await ensureConnect();

    const sendResult = await chrome.runtime.sendMessage({
      type: 'host:ytdlp-cancel',
      url: url
    });

    if (!sendResult || !sendResult.ok) {
      throw new Error('Не удалось отменить загрузку: ' + (sendResult?.error || 'неизвестная ошибка'));
    }

    // Удаляем из активных загрузок
    await removeActiveDownload(url);

    // Обновляем список загрузок
    await loadDownloads();

  } catch (err) {
    log(`Ошибка отмены: ${err.message}`);
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Отменить';
  }
}

// Открыть файл в системе
async function openFile(filepath, openBtn) {
  try {
    if (!filepath) {
      throw new Error('Путь к файлу не указан');
    }

    openBtn.disabled = true;
    const originalText = openBtn.textContent;
    openBtn.textContent = 'Открытие...';

    await ensureConnect();

    const sendResult = await chrome.runtime.sendMessage({
      type: 'host:open-file',
      filepath: filepath
    });

    if (!sendResult || !sendResult.ok) {
      throw new Error('Не удалось открыть файл: ' + (sendResult?.error || 'неизвестная ошибка'));
    }

    // Визуальная обратная связь
    openBtn.textContent = '✓ Открыто';
    setTimeout(() => {
      openBtn.textContent = originalText;
      openBtn.disabled = false;
    }, 1500);

  } catch (err) {
    log(`Ошибка открытия файла: ${err.message}`);
    openBtn.disabled = false;
    openBtn.textContent = 'Открыть';
    alert(`Ошибка открытия файла: ${err.message}`);
  }
}

// Переключение вкладок
function initTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.getAttribute('data-tab');

      // Убираем активность со всех вкладок
      tabButtons.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      // Активируем выбранную вкладку
      btn.classList.add('active');
      document.getElementById(`tab-${tabName}`).classList.add('active');

      // Загружаем данные для вкладки
      if (tabName === 'downloads') {
        loadDownloads();
      } else if (tabName === 'current-page') {
        loadM3u8Urls();
      }
    });
  });
}

// Открытие модального окна настроек
function openSettings() {
  settingsModal.classList.add('visible');
}

// Закрытие модального окна настроек
function closeSettings() {
  settingsModal.classList.remove('visible');
}

// Переключение видимости логов
function toggleLogs() {
  logsContent.classList.toggle('visible');
  if (logsContent.classList.contains('visible')) {
    btnToggleLogs.textContent = '📋 Скрыть логи';
  } else {
    btnToggleLogs.textContent = '📋 Логи отладки';
  }
}

btnRefreshM3u8.addEventListener('click', loadM3u8Urls);
btnClearM3u8.addEventListener('click', clearM3u8Urls);
btnRefreshDownloads.addEventListener('click', async () => {
  // Сверяем activeDownloads с реально идущими загрузками на хосте:
  // зависшие (например, после перезагрузки расширения) переносим в прерванные
  const staleCount = await invalidateStaleDownloads();
  if (staleCount > 0) {
    log(`Прервано загрузок: ${staleCount} (их можно возобновить)`);
  }
  await loadDownloads();
});
btnOpenSettings.addEventListener('click', openSettings);
btnCloseSettings.addEventListener('click', closeSettings);
btnSaveSettings.addEventListener('click', async () => {
  await saveSettings();
  // Закрываем модальное окно после сохранения
  setTimeout(() => {
    closeSettings();
  }, 1500);
});
btnClearLog.addEventListener('click', async () => {
  await chrome.storage.local.remove(UI_LOGS_KEY);
  lastUiLogSeq = 0;
  logEl.textContent = '';
  log('Логи очищены');
});
btnToggleLogs.addEventListener('click', toggleLogs);

// Закрытие модального окна при клике на overlay
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) {
    closeSettings();
  }
});

// Инициализация вкладок
initTabs();

// Загружаем настройки и список при открытии popup
(async () => {
  await loadUiLogs(); // Сначала история событий из storage, затем сессионные сообщения
  await loadSettings();
  await loadM3u8Urls();
  await loadDownloads(); // Загружаем счетчик активных загрузок
})();