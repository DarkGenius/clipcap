# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClipCap is a Chrome browser extension for downloading streaming videos (primarily m3u8/HLS streams). It consists of three main components:

1. **Chrome Extension** (`extension/`) - Browser UI and web request monitoring
2. **Native Host** (`native-host/`) - Node.js application for executing yt-dlp commands
3. **Host Configuration** (`hosts/`) - Native messaging manifests for browser integration

## Architecture

### Communication Flow

```
Chrome Extension (popup.js/background.js)
    ↓ chrome.runtime.connectNative()
Native Messaging Protocol (stdio)
    ↓ JSON messages with length headers
Native Host (index.js)
    ↓ spawn/execFile
yt-dlp binary (external)
```

The extension communicates with the native host using Chrome's Native Messaging protocol, which uses 4-byte length-prefixed JSON messages over stdin/stdout.

### Key Components

**Extension Background Service Worker** (`extension/background.js:1`)
- Maintains persistent connection to native host via `chrome.runtime.connectNative()`
- Intercepts `.m3u8` requests using `chrome.webRequest` API (line 116)
- Stores intercepted URLs in `chrome.storage.local` with page context
- Forwards messages between popup and native host
- Manages download progress state in storage for persistence across popup sessions

**Extension Popup** (`extension/popup.js:1`)
- Tabbed interface: Current Page, Downloads, Settings, Logs
- Sends `host:ytdlp-check` messages to verify video availability and get format info
- Sends `host:ytdlp-download` messages to start downloads with progress tracking
- Handles download cancellation via `host:ytdlp-cancel`
- Persists active downloads in storage to survive popup close/reopen

**Native Host** (`native-host/index.js:1`)
- Node.js script that implements Native Messaging protocol
- Reads 4-byte length header + JSON message from stdin (line 30)
- Handles message types:
  - `host:ytdlp-check` - Runs `yt-dlp --list-formats` and parses output (line 76)
  - `host:ytdlp-download` - Spawns `yt-dlp` with progress monitoring (line 116)
  - `host:ytdlp-cancel` - Kills active download process (line 213)
- Maintains `downloadProcesses` Map for cancellation support (line 16)
- Logs to `host.log` for debugging (line 11)
- Parses yt-dlp output to extract best quality format (line 236)

## Development Commands

### Testing the Extension

1. Load unpacked extension in Chrome:
   - Navigate to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select the `extension/` directory

2. Check extension logs:
   - Right-click extension icon → "Inspect popup" (for popup console)
   - Go to `chrome://extensions/` → Click "background page" link (for service worker console)

### Testing the Native Host

The native host is launched automatically by Chrome, but for manual testing:

```bash
node native-host/index.js
```

Then send test messages via stdin (4-byte little-endian length + JSON):

```javascript
// Example test message for listing formats
{"type":"host:ytdlp-check","ytdlpPath":"E:\\yt-dlp\\yt-dlp.exe","url":"https://example.com/video.m3u8"}
```

### Viewing Native Host Logs

```bash
tail -f native-host/host.log
```

## Native Messaging Setup

The native host must be registered in the Windows registry for Chrome to discover it.

**Registry Location:**
```
HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.example.native_host
```

**Registry Value:** Path to `hosts/windows/com.darkgenius.clipcap.json`

The manifest file points to `native-host/index.cmd` which launches Node.js with `index.js`.

**Important:** The `allowed_origins` in the manifest must match the extension ID.

## Message Protocol

All messages between extension and native host follow this structure:

**Extension → Native Host:**
```javascript
{
  "type": "host:ytdlp-check" | "host:ytdlp-download" | "host:ytdlp-cancel",
  "ytdlpPath": "E:\\yt-dlp\\yt-dlp.exe",
  "url": "https://...",
  "formatId": "...",      // for downloads
  "outputPath": "...",    // for downloads
  "filename": "..."       // for downloads
}
```

**Native Host → Extension:**
```javascript
{
  "type": "ytdlp-check-result" | "ytdlp-download-progress" | "ytdlp-download-complete",
  "ok": true,
  "url": "https://...",
  "success": true,
  "resolution": "1920x1080",
  "filesize": "1.68GiB",
  "formatId": "6864",
  "percent": 45.0,        // for progress
  "filepath": "...",      // for completion
  "error": "..."          // on failure
}
```

## Storage Schema

**chrome.storage.local keys:**

- `m3u8Urls` - Array of detected m3u8 URLs with metadata:
  ```javascript
  [{
    url: "https://...",
    urlWithoutQuery: "https://...without?params",
    timestamp: "2025-10-25T...",
    tabId: 123,
    pageUrl: "https://page-url.com",
    checkResult: {
      success: true,
      formatId: "6864",
      resolution: "1920x1080",
      filesize: "1.68GiB",
      checkedAt: "2025-10-25T..."
    }
  }]
  ```

- `activeDownloads` - Map of in-progress downloads (persists across popup sessions):
  ```javascript
  {
    "https://video.m3u8": {
      formatId: "6864",
      resolution: "1920x1080",
      filename: "video_1080_1730123456.mp4",
      percent: 45.0,
      startedAt: "2025-10-25T..."
    }
  }
  ```

- `ytdlpSettings` - User configuration:
  ```javascript
  {
    ytdlpPath: "E:\\yt-dlp\\yt-dlp.exe",
    ytdlpOutput: "E:\\yt-dlp"
  }
  ```

## yt-dlp Integration

The native host uses yt-dlp (youtube-dl fork) for video downloading.

**Format Selection Algorithm** (`native-host/index.js:236`):
- Parses `yt-dlp --list-formats` output
- Selects highest resolution format by pixel count
- Extracts format ID, resolution, and file size

**Download Progress Parsing** (`native-host/index.js:142`):
- Monitors stdout/stderr for `[download] XX.X%` patterns
- Sends progress updates to extension in real-time
- Handles both regular and fragmented downloads

**Arguments Used:**
- `--list-formats` - Get available formats
- `-f <formatId>` - Select specific format
- `-o <path>` - Output file path
- `--newline` - Ensure progress output on separate lines
- `--no-warnings` - Suppress warning messages

## Code Patterns

### Background Service Worker Persistence
The background script maintains connection state and forwards messages even when popup is closed. Download progress is stored in chrome.storage to survive popup lifecycle.

### Async Message Handling with Storage Fallback
When checking URLs, popup.js sets up both a message listener callback and periodic storage polling (line 403) to handle cases where the popup is closed before receiving the response.

### Process Lifecycle Management
The native host stores spawned child processes in a Map (line 131) to enable cancellation and proper cleanup when downloads are stopped.

### HTML Escaping
Always use `escapeHtml()` function (line 625) when injecting user-controlled data (URLs) into the DOM to prevent XSS.

## Common Tasks

### Adding a new message type
1. Add handler in `native-host/index.js` `handleMessage()` function
2. Add message forwarding in `extension/background.js` line 85 condition
3. Add message handling in `extension/popup.js` `chrome.runtime.onMessage` listener

### Modifying yt-dlp arguments
Edit the args array in `native-host/index.js:123` for downloads or line 81 for format checking.

### Changing filename format
Modify the filename generation in `extension/popup.js:547-549`.
