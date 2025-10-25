# ClipCap

A powerful Chrome browser extension for downloading streaming videos, with primary support for m3u8/HLS streams.

## Features

- Automatic detection of m3u8 video streams on web pages
- Video quality selection and format information
- Download progress tracking with real-time updates
- Persistent downloads that survive popup close/reopen
- Download cancellation support
- Configurable output paths
- Comprehensive logging for troubleshooting

## Architecture

ClipCap consists of three main components:

### 1. Chrome Extension (`extension/`)

Browser-side components including:

- **Background Service Worker**: Monitors web requests, maintains native host connection, and persists download state
- **Popup UI**: Tabbed interface for managing detected streams, active downloads, settings, and logs
- **Storage**: Uses Chrome's local storage to persist URLs, downloads, and user settings

### 2. Native Host (`native-host/`)

Node.js application that:

- Implements Chrome's Native Messaging protocol
- Executes yt-dlp commands for video downloading
- Parses yt-dlp output for format information and progress tracking
- Manages download processes with cancellation support

### 3. Host Configuration (`hosts/`)

Native messaging manifests that enable browser-to-native-host communication.

## Communication Flow

```
Chrome Extension (popup.js/background.js)
    ↓ chrome.runtime.connectNative()
Native Messaging Protocol (stdio)
    ↓ JSON messages with 4-byte length headers
Native Host (index.js)
    ↓ spawn/execFile
yt-dlp binary (external)
```

## Installation

### Prerequisites

1. **yt-dlp**: Download from [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases)

   - Place `yt-dlp.exe` in a known location (e.g., `E:\yt-dlp\yt-dlp.exe`)

2. **Node.js**: Required for the native host (version 14 or higher recommended)

### Extension Setup

1. Clone or download this repository

2. Load the extension in Chrome:

   - Navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top-right corner)
   - Click "Load unpacked"
   - Select the `extension/` directory

3. Note your extension ID (shown on the extension card)

### Native Host Setup (Windows)

1. Install Node.js dependencies:

   ```bash
   cd native-host
   npm install
   ```

2. Update the manifest file:

   - Open `hosts/windows/com.darkgenius.clipcap.json`
   - Update the `path` field to point to `native-host/index.cmd` (use absolute path)
   - Update `allowed_origins` to include your extension ID:
     ```json
     "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
     ```

3. Register the native host in Windows Registry:

   - Create registry key: `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.darkgenius.clipcap`
   - Set default value to the absolute path of `hosts/windows/com.darkgenius.clipcap.json`

   Example using Command Prompt (run as Administrator):

   ```cmd
   REG ADD "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.darkgenius.clipcap" /ve /d "E:\Projects\clipcap\hosts\windows\com.darkgenius.clipcap.json" /f
   ```

## Usage

### Configuring yt-dlp Path

1. Click the ClipCap extension icon
2. Go to the "Settings" tab
3. Enter the path to your yt-dlp executable (e.g., `E:\yt-dlp\yt-dlp.exe`)
4. Enter your preferred output directory (e.g., `E:\yt-dlp`)
5. Click "Save Settings"

### Downloading Videos

1. Navigate to a webpage with video content
2. Click the ClipCap extension icon
3. The "Current Page" tab will show detected m3u8 URLs
4. Click "Check" to verify the video and see available formats
5. Once checked, click "Download" to start downloading
6. Monitor progress in the "Downloads" tab
7. Cancel downloads if needed using the "Cancel" button

### Viewing Logs

- Extension logs: Right-click extension icon → "Inspect popup" (popup console)
- Background worker logs: `chrome://extensions/` → Click "service worker" link
- Native host logs: Check `native-host/host.log`

## Project Structure

```
clipcap/
├── extension/               # Chrome extension files
│   ├── manifest.json       # Extension manifest (Manifest V3)
│   ├── background.js       # Service worker (web request monitoring, native messaging)
│   ├── popup.html          # Extension popup UI
│   ├── popup.js            # Popup logic and download management
│   └── icon*.png           # Extension icons
├── native-host/            # Native messaging host
│   ├── index.js            # Main host script (message handling, yt-dlp integration)
│   ├── index.cmd           # Windows launcher script
│   ├── package.json        # Node.js dependencies
│   └── host.log            # Runtime logs (auto-generated)
├── hosts/                  # Native messaging manifests
│   └── windows/
│       └── com.darkgenius.clipcap.json  # Windows registry manifest
├── CLAUDE.md               # AI assistant development guide
├── .gitignore              # Git ignore rules
└── README.md               # This file
```

## Development

### Message Protocol

All messages between the extension and native host use this structure:

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

### Storage Schema

**chrome.storage.local keys:**

- `m3u8Urls`: Array of detected streams with metadata and check results
- `activeDownloads`: Map of in-progress downloads (persists across popup sessions)
- `ytdlpSettings`: User configuration (paths to yt-dlp and output directory)

See `CLAUDE.md` for detailed schema documentation.

### Testing

**Testing the Extension:**

1. Make changes to extension files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the ClipCap card
4. Test functionality in the popup

**Testing the Native Host:**

```bash
# Manual testing (sends messages via stdin)
node native-host/index.js

# View logs in real-time
tail -f native-host/host.log
```

### Adding Features

Common development tasks:

1. **Adding a new message type:**

   - Add handler in `native-host/index.js` in `handleMessage()`
   - Add forwarding logic in `extension/background.js`
   - Add message handling in `extension/popup.js`

2. **Modifying yt-dlp arguments:**

   - Edit args array in `native-host/index.js` (lines 81 and 123)

3. **Changing filename format:**
   - Modify filename generation in `extension/popup.js` (around line 547)

## yt-dlp Integration

ClipCap uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) for video downloading.

**Format Selection:**

- Automatically selects the highest resolution format by pixel count
- Extracts format ID, resolution, and file size from `--list-formats` output

**Progress Tracking:**

- Monitors yt-dlp stdout/stderr for `[download] XX.X%` patterns
- Sends real-time progress updates to the extension
- Handles both regular and fragmented downloads

## Troubleshooting

### Extension not detecting videos

- Check if the page actually uses m3u8/HLS streams
- Open DevTools Network tab and filter for "m3u8" to verify
- Check background service worker console for errors

### Native host connection fails

- Verify registry key is set correctly
- Check that `allowed_origins` in manifest matches your extension ID
- Ensure `index.cmd` points to correct Node.js installation
- Check `native-host/host.log` for errors

### Downloads fail or hang

- Verify yt-dlp path is correct in Settings
- Test yt-dlp directly: `yt-dlp --list-formats <url>`
- Check `native-host/host.log` for yt-dlp errors
- Ensure output directory exists and is writable

## Security Considerations

- The extension only intercepts m3u8 URLs (filtered by Chrome's webRequest API)
- User-controlled data (URLs) is properly escaped before DOM injection
- Native host validates message structure before processing
- Downloads are scoped to user-configured output directory

## License

MIT

## Contributing

You are welcome!
