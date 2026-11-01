const HOST_NAME = "com.darkgenius.clipcap";
let port = null;

// Ключ для хранения активных загрузок
const ACTIVE_DOWNLOADS_KEY = "activeDownloads";
// Ключ для хранения завершенных загрузок
const COMPLETED_DOWNLOADS_KEY = "completedDownloads";
// Ключ для хранения прерванных загрузок
const INTERRUPTED_DOWNLOADS_KEY = "interruptedDownloads";
// Ключ для персистентного лога событий, отображаемого на вкладке "Логи" в popup
const UI_LOGS_KEY = "uiLogs";
const UI_LOGS_MAX = 300;

// Запись в лог сериализована: события могут приходить пачкой,
// а chrome.storage не защищает от гонок read-modify-write
let uiLogWriteChain = Promise.resolve();
function appendUiLog(text) {
  uiLogWriteChain = uiLogWriteChain.then(async () => {
    const result = await chrome.storage.local.get([UI_LOGS_KEY]);
    const logs = result[UI_LOGS_KEY] || [];
    const lastSeq = logs.length ? logs[logs.length - 1].seq || 0 : 0;
    logs.push({ seq: lastSeq + 1, time: new Date().toISOString(), text });
    if (logs.length > UI_LOGS_MAX) logs.splice(0, logs.length - UI_LOGS_MAX);
    await chrome.storage.local.set({ [UI_LOGS_KEY]: logs });
  });
  return uiLogWriteChain;
}

function connect() {
  if (port) return;
  console.log("[Background] Connecting to native host:", HOST_NAME);
  port = chrome.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener(async (msg) => {
    console.log("[Background] Message from native host:", msg);

    // Сохраняем результат проверки yt-dlp в storage
    if (msg?.type === "ytdlp-check-result") {
      console.log("[Background] Saving yt-dlp result to storage:", msg.url);
      await chrome.storage.local.set({
        [`ytdlp-result-${msg.url}`]: msg,
      });
      if (msg.success === false && msg.error) {
        appendUiLog(`Проверка не удалась: ${msg.url} — ${msg.error}`);
      }
    }

    // Сохраняем результат запроса статуса загрузок в storage
    // (popup читает его через polling, как и результаты проверки)
    if (msg?.type === "ytdlp-status-result") {
      console.log(
        "[Background] Saving ytdlp status to storage:",
        msg.activeUrls?.length || 0,
        "active"
      );
      await chrome.storage.local.set({ "ytdlp-status-result": msg });
    }

    // Обрабатываем сообщения о прогрессе загрузки
    if (msg?.type === "ytdlp-download-progress") {
      console.log(
        "[Background] Download progress:",
        msg.url,
        msg.percent + "%"
      );

      // Обновляем прогресс в storage даже если popup закрыт
      const result = await chrome.storage.local.get([ACTIVE_DOWNLOADS_KEY]);
      const activeDownloads = result[ACTIVE_DOWNLOADS_KEY] || {};

      if (activeDownloads[msg.url]) {
        activeDownloads[msg.url].percent = msg.percent;
        await chrome.storage.local.set({
          [ACTIVE_DOWNLOADS_KEY]: activeDownloads,
        });
        console.log(
          "[Background] Updated progress in storage:",
          msg.url,
          msg.percent + "%"
        );
      } else {
        console.warn(
          "[Background] No active download found in storage for:",
          msg.url
        );
      }
    }

    // Обрабатываем завершение загрузки
    if (msg?.type === "ytdlp-download-complete") {
      console.log(
        "[Background] Download complete:",
        msg.url,
        "success:",
        msg.success
      );

      // Получаем активные загрузки
      const result = await chrome.storage.local.get([
        ACTIVE_DOWNLOADS_KEY,
        COMPLETED_DOWNLOADS_KEY,
        INTERRUPTED_DOWNLOADS_KEY,
      ]);
      const activeDownloads = result[ACTIVE_DOWNLOADS_KEY] || {};
      const completedDownloads = result[COMPLETED_DOWNLOADS_KEY] || {};
      const interruptedDownloads = result[INTERRUPTED_DOWNLOADS_KEY] || {};

      // Пишем событие в персистентный лог (попап обычно закрыт в этот момент)
      const logName = activeDownloads[msg.url]?.filename || msg.url;
      if (msg.success) {
        appendUiLog(`Загрузка завершена: ${msg.filepath}`);
      } else if (msg.error === "Загрузка отменена") {
        appendUiLog(`Загрузка отменена: ${logName}`);
      } else {
        appendUiLog(`Ошибка загрузки ${logName}: ${msg.error || "неизвестная ошибка"}`);
      }

      // Если загрузка была активной
      if (activeDownloads[msg.url]) {
        const downloadData = activeDownloads[msg.url];

        // Если загрузка успешна, сохраняем в завершенные
        if (msg.success) {
          completedDownloads[msg.url] = {
            ...downloadData,
            filepath: msg.filepath,
            success: true,
            completedAt: new Date().toISOString(),
          };
          console.log(
            "[Background] Saved completed download to storage:",
            msg.url
          );
        } else if (msg.error !== "Загрузка отменена") {
          // Ошибка (не отмена) — сохраняем в прерванные, чтобы можно было
          // возобновить с тем же именем файла (yt-dlp докачает по .part/.ytdl)
          interruptedDownloads[msg.url] = {
            ...downloadData,
            interruptedAt: new Date().toISOString(),
            lastError: msg.error,
          };
          console.log(
            "[Background] Saved failed download as interrupted:",
            msg.url,
            msg.error
          );
        }

        // Удаляем из активных загрузок
        delete activeDownloads[msg.url];

        // Сохраняем обновленные данные
        await chrome.storage.local.set({
          [ACTIVE_DOWNLOADS_KEY]: activeDownloads,
          [COMPLETED_DOWNLOADS_KEY]: completedDownloads,
          [INTERRUPTED_DOWNLOADS_KEY]: interruptedDownloads,
        });
        console.log(
          "[Background] Removed from active downloads:",
          msg.url
        );
      }
    }

    // Пытаемся отправить в popup
    try {
      await chrome.runtime.sendMessage({ source: "native-host", payload: msg });
      console.log("[Background] Message forwarded to popup");
    } catch (err) {
      console.warn(
        "[Background] Failed to forward message to popup (popup might be closed):",
        err.message
      );
      // Это нормально, если popup закрыт - результат сохранен в storage
    }
  });
  port.onDisconnect.addListener(() => {
    console.log("[Background] Native host disconnected");
    if (chrome.runtime.lastError) {
      console.error("[Background] Disconnect error:", chrome.runtime.lastError);
      appendUiLog(
        `Нативный хост отключился: ${chrome.runtime.lastError.message || "неизвестная ошибка"}`
      );
    }
    port = null;
  });
  console.log("[Background] Connected to native host");
}

chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Background] Received message:", message);

  if (message?.type === "ensure-connect") {
    console.log("[Background] Ensuring connection...");
    connect();
    sendResponse({ ok: true });
    return true;
  }
  if (
    message?.type === "host:exec" ||
    message?.type === "host:list" ||
    message?.type === "host:ytdlp-check" ||
    message?.type === "host:ytdlp-download" ||
    message?.type === "host:ytdlp-cancel" ||
    message?.type === "host:ytdlp-status" ||
    message?.type === "host:open-file"
  ) {
    console.log(
      "[Background] Forwarding message to native host:",
      message.type
    );
    connect();
    if (!port) {
      console.error("[Background] No port available");
      sendResponse({ ok: false, error: "No port" });
      return true;
    }
    console.log("[Background] Posting message to native host");
    port.postMessage(message);
    console.log("[Background] Message posted");
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "get-m3u8-urls") {
    chrome.storage.local.get(["m3u8Urls"], (result) => {
      console.log(
        "[Background] Retrieved m3u8 URLs:",
        result.m3u8Urls?.length || 0
      );
      sendResponse({ urls: result.m3u8Urls || [] });
    });
    return true;
  }
  if (message?.type === "clear-m3u8-urls") {
    console.log("[Background] Clearing m3u8 URLs");
    chrome.storage.local.set({ m3u8Urls: [] }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
});

// Извлечение m3u8 URL (прямой или из query-параметра прокси)
function extractM3u8Url(fullUrl) {
  // Случай 1: Прямая ссылка на .m3u8
  const urlWithoutQuery = fullUrl.split("?")[0];
  if (urlWithoutQuery.endsWith(".m3u8")) {
    return { isM3u8: true, effectiveUrl: fullUrl, urlWithoutQuery };
  }

  // Случай 2: Прокси-ссылка с m3u8 URL в query-параметре
  try {
    const parsed = new URL(fullUrl);
    for (const [, value] of parsed.searchParams) {
      const valueWithoutQuery = value.split("?")[0];
      if (valueWithoutQuery.endsWith(".m3u8")) {
        return {
          isM3u8: true,
          effectiveUrl: value,
          urlWithoutQuery: valueWithoutQuery,
        };
      }
    }
  } catch (e) {
    // Некорректный URL, пропускаем
  }

  return { isM3u8: false };
}

// Расширения прогрессивных видеофайлов (прямые ссылки, не HLS)
const MEDIA_FILE_EXTENSIONS = /\.(mp4|m4v|webm|mov|mkv)$/i;

// Сегменты HLS/DASH: init.mp4, seg_3.mp4, chunk-1.m4s. Приходят как type 'media',
// но это куски уже найденного плейлиста — по отдельности качать их бессмысленно,
// а yt-dlp на них падает ("Ошибка выполнения yt-dlp" на .../audio/130/seg_3.mp4)
const MEDIA_SEGMENT_NAME = /^(?:init|seg|segment|chunk|frag|fragment)[-_]?\d*\.[a-z0-9]+$/i;

function isMediaSegment(urlWithoutQuery) {
  const filename = urlWithoutQuery.split("/").pop() || "";
  return MEDIA_SEGMENT_NAME.test(filename);
}

// Отслеживание видеозапросов: HLS-плейлисты (.m3u8) и прямые видеофайлы
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    const url = details.url;
    const extracted = extractM3u8Url(url);

    // details.type === 'media' — запросы от <video>/<audio> элементов:
    // так ловим прогрессивные MP4 без мусора (превью, реклама грузятся иначе)
    let mediaKind = null;
    if (extracted.isM3u8) {
      mediaKind = "hls";
    } else {
      const withoutQuery = url.split("?")[0];
      if (withoutQuery.endsWith(".mpd")) {
        // DASH-манифест: Cloudflare Stream и другие CDN отдают его наравне с m3u8,
        // и плеер в Chrome нередко берёт именно его — без этого видео не находится
        mediaKind = "dash";
        extracted.effectiveUrl = url;
        extracted.urlWithoutQuery = withoutQuery;
      } else if (
        details.type === "media" &&
        MEDIA_FILE_EXTENSIONS.test(withoutQuery) &&
        !isMediaSegment(withoutQuery)
      ) {
        mediaKind = "file";
        extracted.effectiveUrl = url;
        extracted.urlWithoutQuery = withoutQuery;
      }
    }

    if (mediaKind) {
      const tabId = details.tabId;

      // Получаем URL страницы из вкладки
      let pageUrl = null;
      try {
        if (tabId && tabId >= 0) {
          const tab = await chrome.tabs.get(tabId);
          pageUrl = tab.url;
        }
      } catch (err) {
        console.error("[Background] Failed to get tab URL:", err);
        pageUrl = details.initiator || details.documentUrl || "unknown";
      }

      addM3u8Url({
        url: url,
        effectiveUrl: extracted.effectiveUrl,
        urlWithoutQuery: extracted.urlWithoutQuery,
        mediaKind: mediaKind,
        timestamp: new Date().toISOString(),
        tabId: tabId,
        pageUrl: pageUrl,
      });
    }
  },
  { urls: ["<all_urls>"] }
);

// Список найденных URL ограничен по возрасту и количеству. Без этого он рос
// бесконечно (каждый пойманный запрос со всех сайтов, ~1 КБ на запись), упёрся
// в квоту chrome.storage.local (10 МБ) — и после этого любой set() молча
// отклонялся: новые видео переставали находиться, загрузки — сохраняться
const M3U8_URLS_KEY = "m3u8Urls";
const M3U8_URLS_MAX = 1000;
const M3U8_URLS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Записи добавляются в конец, так что массив упорядочен от старых к новым
function pruneM3u8Urls(urls) {
  const cutoff = Date.now() - M3U8_URLS_MAX_AGE_MS;
  const fresh = urls.filter((item) => !(Date.parse(item.timestamp) < cutoff));
  return fresh.length > M3U8_URLS_MAX
    ? fresh.slice(fresh.length - M3U8_URLS_MAX)
    : fresh;
}

// Запись сериализована: плеер шлёт пачку запросов (манифест, дорожки) почти
// одновременно, и параллельные read-modify-write затирали бы друг друга
let m3u8WriteChain = Promise.resolve();
function updateM3u8Urls(mutate) {
  m3u8WriteChain = m3u8WriteChain
    .then(async () => {
      const result = await chrome.storage.local.get([M3U8_URLS_KEY]);
      const urls = result[M3U8_URLS_KEY] || [];
      const updated = mutate(urls);
      if (updated) await chrome.storage.local.set({ [M3U8_URLS_KEY]: updated });
    })
    .catch((err) => {
      // Ошибку записи (например, переполнение квоты) нельзя терять молча
      console.error("[Background] Failed to update m3u8 URLs:", err);
    });
  return m3u8WriteChain;
}

function addM3u8Url(entry) {
  return updateM3u8Urls((urls) => {
    if (urls.some((item) => item.url === entry.url)) return null;
    urls.push(entry);
    console.log("[Background] Saved m3u8 URL:", entry.url, "from page:", entry.pageUrl);
    return pruneM3u8Urls(urls);
  });
}

// Чистим при каждом старте service worker: сразу освобождает место,
// если хранилище уже переполнено
updateM3u8Urls((urls) => {
  const pruned = pruneM3u8Urls(urls);
  if (pruned.length === urls.length) return null;
  console.log(`[Background] Pruned m3u8 URLs: ${urls.length} -> ${pruned.length}`);
  return pruned;
});
