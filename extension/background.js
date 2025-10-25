const HOST_NAME = "com.darkgenius.clipcap";
let port = null;

// Ключ для хранения активных загрузок
const ACTIVE_DOWNLOADS_KEY = "activeDownloads";
// Ключ для хранения завершенных загрузок
const COMPLETED_DOWNLOADS_KEY = "completedDownloads";

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
      ]);
      const activeDownloads = result[ACTIVE_DOWNLOADS_KEY] || {};
      const completedDownloads = result[COMPLETED_DOWNLOADS_KEY] || {};

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
        }

        // Удаляем из активных загрузок
        delete activeDownloads[msg.url];

        // Сохраняем обновленные данные
        await chrome.storage.local.set({
          [ACTIVE_DOWNLOADS_KEY]: activeDownloads,
          [COMPLETED_DOWNLOADS_KEY]: completedDownloads,
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

// Отслеживание .m3u8 запросов
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    const url = details.url;
    // Убираем query-параметры
    const urlWithoutQuery = url.split("?")[0];

    // Проверяем, заканчивается ли URL на .m3u8
    if (urlWithoutQuery.endsWith(".m3u8")) {
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

      chrome.storage.local.get(["m3u8Urls"], (result) => {
        const urls = result.m3u8Urls || [];
        // Добавляем URL, если его еще нет в списке
        if (!urls.some((item) => item.url === url)) {
          urls.push({
            url: url,
            urlWithoutQuery: urlWithoutQuery,
            timestamp: new Date().toISOString(),
            tabId: tabId,
            pageUrl: pageUrl,
          });
          chrome.storage.local.set({ m3u8Urls: urls });
          console.log(
            "[Background] Saved m3u8 URL:",
            url,
            "from page:",
            pageUrl
          );
        }
      });
    }
  },
  { urls: ["<all_urls>"] }
);
