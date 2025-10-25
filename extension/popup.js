const logEl = document.getElementById('log');
const btnRefreshM3u8 = document.getElementById('btn-refresh-m3u8');
const btnClearM3u8 = document.getElementById('btn-clear-m3u8');
const m3u8ListEl = document.getElementById('m3u8-list');
const m3u8CountEl = document.getElementById('m3u8-count');
const currentPageEl = document.getElementById('current-page');
const ytdlpPathInput = document.getElementById('ytdlp-path');
const ytdlpOutputInput = document.getElementById('ytdlp-output');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnClearLog = document.getElementById('btn-clear-log');
const btnToggleSettings = document.getElementById('btn-toggle-settings');
const btnToggleLogs = document.getElementById('btn-toggle-logs');
const settingsContent = document.getElementById('settings-content');
const logsContent = document.getElementById('logs-content');
const downloadsListEl = document.getElementById('downloads-list');
const activeDownloadsCountEl = document.getElementById('active-downloads-count');
const btnRefreshDownloads = document.getElementById('btn-refresh-downloads');

// Значения по умолчанию
const DEFAULT_SETTINGS = {
  ytdlpPath: 'E:\\yt-dlp\\yt-dlp.exe',
  ytdlpOutput: 'E:\\yt-dlp'
};

// Хранилище для обратных вызовов проверки URL
const pendingChecks = new Map();

// Ключ для хранения активных загрузок
const ACTIVE_DOWNLOADS_KEY = 'activeDownloads';

function log(msg) {
  logEl.textContent += (typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2)) + '\n';
}

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
          filesize: result.filesize,
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

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg?.source === 'native-host') {
    // Обработка ответа от yt-dlp проверки
    if (msg.payload?.type === 'ytdlp-check-result') {
      const { url, success, formatId, resolution, filesize, error } = msg.payload;

      const result = { success, formatId, resolution, filesize, error };

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
          // Добавляем кнопку "Скачать" если ее еще нет
          const existingDownloadBtn = btn.parentElement.querySelector('.download-btn');
          if (!existingDownloadBtn) {
            const downloadBtn = document.createElement('button');
            downloadBtn.className = 'download-btn';
            downloadBtn.textContent = 'Скачать';
            downloadBtn.setAttribute('data-url', url);
            downloadBtn.setAttribute('data-formatid', formatId || '');
            downloadBtn.setAttribute('data-resolution', resolution);
            downloadBtn.addEventListener('click', async (e) => {
              await downloadM3u8(url, formatId, resolution, e.target);
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
      const { url, percent } = msg.payload;

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

      // Удаляем из активных загрузок
      await removeActiveDownload(url);

      // Обновляем счетчик и список загрузок
      const activeDownloads = await getActiveDownloads();
      activeDownloadsCountEl.textContent = Object.keys(activeDownloads).length;

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
  const settings = result.ytdlpSettings || DEFAULT_SETTINGS;
  ytdlpPathInput.value = settings.ytdlpPath || DEFAULT_SETTINGS.ytdlpPath;
  ytdlpOutputInput.value = settings.ytdlpOutput || DEFAULT_SETTINGS.ytdlpOutput;
  return settings;
}

async function saveSettings() {
  const settings = {
    ytdlpPath: ytdlpPathInput.value || DEFAULT_SETTINGS.ytdlpPath,
    ytdlpOutput: ytdlpOutputInput.value || DEFAULT_SETTINGS.ytdlpOutput
  };
  await chrome.storage.local.set({ ytdlpSettings: settings });

  // Визуальная обратная связь
  const originalText = btnSaveSettings.textContent;
  btnSaveSettings.textContent = '✓ Сохранено';
  btnSaveSettings.style.background = '#e8f5e9';
  setTimeout(() => {
    btnSaveSettings.textContent = originalText;
    btnSaveSettings.style.background = '';
  }, 1500);
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
    m3u8ListEl.innerHTML = '<div class="empty-state">На этой странице не найдено .m3u8 запросов</div>';
  } else {
    m3u8ListEl.innerHTML = urls
      .reverse() // Последние сверху
      .map((item, index) => {
        const date = new Date(item.timestamp);
        const timeStr = date.toLocaleTimeString('ru-RU');

        // Проверяем, есть ли сохраненный результат проверки
        let infoHtml = '';
        let btnText = 'Проверить';
        let downloadBtn = '';
        if (item.checkResult) {
          btnText = 'Перепроверить';
          if (item.checkResult.success && item.checkResult.resolution) {
            infoHtml = `<div class="info success">Разрешение: ${item.checkResult.resolution}, Размер: ${item.checkResult.filesize || 'неизвестен'}</div>`;
            // Добавляем кнопку скачать если проверка успешна
            downloadBtn = `<button class="download-btn" data-url="${escapeHtml(item.url)}" data-formatid="${item.checkResult.formatId || ''}" data-resolution="${item.checkResult.resolution}">Скачать</button>`;
          } else {
            infoHtml = `<div class="info error">${item.checkResult.error || 'Видеопоток не найден'}</div>`;
          }
        }

        return `
          <div class="m3u8-item" data-index="${index}">
            <div class="url">${escapeHtml(item.url)}</div>
            <div class="time">${timeStr}</div>
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
        await downloadM3u8(url, formatId, resolution, e.target);
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

      // Добавляем кнопку "Скачать"
      const existingDownloadBtn = btnElement.parentElement.querySelector('.download-btn');
      if (!existingDownloadBtn) {
        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'download-btn';
        downloadBtn.textContent = 'Скачать';
        downloadBtn.setAttribute('data-url', url);
        downloadBtn.setAttribute('data-formatid', result.formatId || '');
        downloadBtn.setAttribute('data-resolution', result.resolution);
        downloadBtn.addEventListener('click', async (e) => {
          await downloadM3u8(url, result.formatId, result.resolution, e.target);
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

async function downloadM3u8(url, formatId, resolution, btnElement) {
  const progressContainer = btnElement.parentElement.querySelector('.progress-container');
  const infoContainer = btnElement.parentElement.querySelector('.info-container');

  try {
    btnElement.disabled = true;

    // Получаем настройки
    const settings = await loadSettings();

    // Генерируем имя файла
    const resolutionShort = resolution.split('x')[1]; // Берем только высоту (например, 1080 из 1920x1080)
    const timestamp = Date.now();
    const filename = `video_${resolutionShort}_${timestamp}.mp4`;

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
      outputPath: settings.ytdlpOutput,
      filename: filename
    });

    if (!sendResult || !sendResult.ok) {
      throw new Error('Не удалось запустить загрузку: ' + (sendResult?.error || 'неизвестная ошибка'));
    }

    // Сохраняем активную загрузку в storage
    await saveActiveDownload(url, {
      formatId,
      resolution,
      filename,
      percent: 0
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
  const downloadCount = Object.keys(activeDownloads).length;

  // Обновляем счетчик в заголовке вкладки
  activeDownloadsCountEl.textContent = downloadCount;

  if (downloadCount === 0) {
    downloadsListEl.innerHTML = '<div class="empty-state">Нет активных загрузок</div>';
    return;
  }

  // Формируем HTML для каждой загрузки
  const downloadsHtml = Object.entries(activeDownloads).map(([url, data], index) => {
    const shortUrl = url.length > 100 ? url.substring(0, 100) + '...' : url;
    const percent = data.percent || 0;

    return `
      <div class="download-item" data-url="${escapeHtml(url)}" data-index="${index}">
        <div class="url" title="${escapeHtml(url)}">${escapeHtml(shortUrl)}</div>
        <div class="filename">📁 ${escapeHtml(data.filename || 'video.mp4')} • ${data.resolution || 'неизвестно'}</div>
        <div class="progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${percent}%"></div>
            <div class="progress-text">${percent.toFixed(1)}%</div>
          </div>
          <button class="cancel-btn" data-index="${index}">Отменить</button>
        </div>
      </div>
    `;
  }).join('');

  downloadsListEl.innerHTML = downloadsHtml;

  // Добавляем обработчики для кнопок отмены
  const cancelButtons = downloadsListEl.querySelectorAll('.cancel-btn');
  Object.entries(activeDownloads).forEach(([url, data], index) => {
    const btn = cancelButtons[index];
    if (btn) {
      btn.addEventListener('click', async () => {
        await cancelDownloadFromList(url, btn);
      });
    }
  });
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

// Переключение видимости настроек
function toggleSettings() {
  settingsContent.classList.toggle('visible');
  if (settingsContent.classList.contains('visible')) {
    btnToggleSettings.textContent = '⚙️ Скрыть настройки';
  } else {
    btnToggleSettings.textContent = '⚙️ Настройки';
  }
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
btnRefreshDownloads.addEventListener('click', loadDownloads);
btnSaveSettings.addEventListener('click', () => {
  saveSettings();
  // Скрываем настройки после сохранения
  setTimeout(() => {
    if (settingsContent.classList.contains('visible')) {
      toggleSettings();
    }
  }, 500);
});
btnClearLog.addEventListener('click', () => {
  logEl.textContent = '';
  log('Логи очищены');
});
btnToggleSettings.addEventListener('click', toggleSettings);
btnToggleLogs.addEventListener('click', toggleLogs);

// Инициализация вкладок
initTabs();

// Загружаем настройки и список при открытии popup
loadSettings();
loadM3u8Urls();
loadDownloads(); // Загружаем счетчик активных загрузок