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
- Intercepts `.m3u8` requests using `chrome.webRequest` API
- Detects both direct `.m3u8` URLs and proxy/wrapped URLs (e.g., `m3u8.gammacdn.com/?u=...`) via `extractM3u8Url()`
- Also detects **progressive video files** (mp4/m4v/webm/mov/mkv): requests with `details.type === 'media'` (issued by `<video>`/`<audio>` elements, so previews/ads don't match) whose path ends with a known video extension; stored with `mediaKind: 'file'` vs `'hls'`
- **HLS/DASH segments are filtered out** (`isMediaSegment()`): `init.mp4`, `seg_3.mp4`, `chunk-1.m4s` also arrive as `type === 'media'`, but they are fragments of a playlist that is already in the list — downloading one alone is meaningless and yt-dlp errors out on it. Matched by filename against `MEDIA_SEGMENT_NAME` (`init|seg|segment|chunk|frag|fragment` + optional separator + optional digits + extension), so ordinary names like `initial-cut.mp4` still pass
- **DASH manifests** (`.mpd`) are detected like `.m3u8`, regardless of request type, and stored with `mediaKind: 'dash'`. Chrome players often choose DASH over HLS, so without this the video may not be found at all
- Stores intercepted URLs in `chrome.storage.local` with page context, including `effectiveUrl` for display
- Forwards messages between popup and native host
- Manages download progress state in storage for persistence across popup sessions

**Extension Popup** (`extension/popup.js:1`)
- Tabbed interface: Current Page, Downloads, Settings, Logs
- Sends `host:ytdlp-check` messages to verify video availability and get format info
- Sends `host:ytdlp-download` messages to start downloads with progress tracking
- Handles download cancellation via `host:ytdlp-cancel`
- Persists active downloads in storage to survive popup close/reopen
- **Stale download invalidation**: the Refresh button on the Downloads tab calls `invalidateStaleDownloads()` — queries the host via `host:ytdlp-status` and moves `activeDownloads` entries the host doesn't know about (e.g., after extension reload) into `interruptedDownloads`, shown in a "Прерванные загрузки" section
- **Resume support**: interrupted downloads keep their filename; "Продолжить" (or re-clicking "Скачать" for a URL with an interrupted entry) restarts yt-dlp with the SAME output filename, so yt-dlp resumes from its `.part`/`.ytdl` files instead of starting over. Failed (non-cancelled) downloads are also moved to interrupted by background.js for the same reason

**Native Host** (`native-host/index.js:1`)
- Node.js script that implements Native Messaging protocol (requires Node 18+ for global `fetch`)
- Reads 4-byte length header + JSON message from stdin
- Handles message types:
  - `host:ytdlp-check` - Runs `yt-dlp --list-formats` and parses output
  - `host:ytdlp-download` - Spawns `yt-dlp` with progress monitoring; remembers the last `ERROR:` line from yt-dlp output (stdout or stderr) and includes it in the `error` field of `ytdlp-download-complete` on failure (e.g. "ERROR: unable to write data: [Errno 28] No space left on device (код: 1)"), instead of just the exit code
  - `host:ytdlp-cancel` - Kills active download process (on Windows uses `taskkill /T /F` to kill the whole process tree, since yt-dlp.exe is a PyInstaller bundle that spawns a child process)
  - `host:ytdlp-status` - Returns `activeUrls` list of downloads running in THIS host instance; used by the popup to detect stale downloads after a host restart (extension reload kills the host and its yt-dlp children)
- Maintains `downloadProcesses` Map for cancellation support and `cancelledDownloads` Set to report cancellation correctly on close
- Logs to `host.log` for debugging, with size-based rotation: at 5 MB the file is rotated to `host.log.1` and up to `MAX_LOG_FILES` (3) old files are kept, so the log cannot grow unbounded (every yt-dlp output line is logged; it had reached 308 MB). Writes go through a promise chain because `log()` is often called without `await` from the yt-dlp stdout/stderr handlers, and a rotation must not interleave with an append
- Parses yt-dlp output to extract best quality format via `parseYtDlpOutput()`
- **Master playlist discovery** via `findMasterPlaylist()`: when the checked URL is an HLS media playlist (single variant, no resolution info — e.g., `video_2.m3u8`), probes sibling filenames (`video.m3u8` — Cloudflare Stream, `playlist.m3u8`, `master.m3u8`, `index.m3u8`, `manifest.m3u8`) with the same query string. If a master playlist (`#EXT-X-STREAM-INF`) is found, matches the checked filename against variant URIs in the master (`findVariantResolution()`) to determine which resolution THIS URL corresponds to, re-runs the check on the master, and selects exactly that variant's format (each `video_N.m3u8` reports its own resolution/size, not the best one). The master URL is returned as `downloadUrl` in the check result; the extension passes it back in `host:ytdlp-download`, while progress/cancel remain keyed by the original `url`. If the variant can't be matched, the master is not used.
- Falls back to URL-based resolution guessing via `guessResolutionFromUrl()` when yt-dlp reports "unknown" and no master playlist is found
- **HLS duration and size estimation** (`getHlsMeta()`): for some CDNs (notably Cloudflare Stream) yt-dlp reports neither duration nor filesize, so the host computes duration itself by summing `#EXTINF` values in the media playlist (`parseHlsDuration()`) and estimates size as `AVERAGE-BANDWIDTH × duration / 8` using the matching variant from the master playlist (`parseMasterVariants()`). The estimate lands within ~1-2% of the real file. Because of this, the master playlist is now probed whenever resolution OR filesize is unknown (previously only on unknown resolution); the playlist body fetched for that probe is reused, so there is no extra request. `duration` (seconds) is returned in the check result and shown in the popup — it is what distinguishes a full video from a trailer when several similar URLs are detected
- **DASH duration and size estimation** (`getDashMeta()`): parses `mediaPresentationDuration` (ISO 8601) and `<Representation>` `bandwidth`/`width`/`height` from the MPD. Since `@bandwidth` in DASH is the peak rate (overestimates size by ~50%), it first looks for a sibling HLS master in the same directory (`findSiblingHlsBandwidth()`) and prefers its `AVERAGE-BANDWIDTH`, falling back to the MPD value
- The HEAD/tkhd probing below is gated on `MEDIA_FILE_EXTENSIONS` rather than "not .m3u8" — otherwise a `.mpd` manifest's own Content-Length would be reported as the video size
- For direct video files (non-.m3u8 URLs) with no filesize from yt-dlp, gets the exact size via HEAD request Content-Length (`fetchContentLength()`)
- For direct mp4/m4v/mov files with unknown resolution, parses the `tkhd` MP4 box to get the exact video track resolution (`probeMp4Resolution()`): first tries the head 3MB (faststart files), then locates the `moov` box by walking top-level boxes (`findMoovBox()`, one 16-byte Range request per box header) and downloads the moov from its start (capped at 16MB) — a fixed-size tail window is NOT enough, since moov can exceed it and then only the audio track's zero-size `tkhd` lands in the window. Fetches Content-Length itself when the caller didn't (yt-dlp may have already reported a filesize, skipping the HEAD)
- `parseYtDlpOutput()` accepts non-numeric format IDs (direct files get e.g. `mp4` as format ID from yt-dlp's generic extractor)

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

Rotated files are `native-host/host.log.1` … `host.log.3` (newest first):

```bash
cat native-host/host.log.1 native-host/host.log
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
  "url": "https://...",       // original URL (key for progress/cancel)
  "downloadUrl": "https://...", // for downloads: alternative URL for yt-dlp (e.g., discovered master playlist), optional
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
  "downloadUrl": "https://...", // for check result: master playlist URL if discovered, null otherwise
  "success": true,
  "resolution": "1920x1080",    // or "1920x1080 (?)" when guessed, or "unknown"
  "filesize": "1.68GiB",        // null when unknown; "~61.41MiB" when estimated from HLS bandwidth
  "duration": 154,              // seconds, from the HLS playlist; null when unknown
  "formatId": "6864",
  "percent": 45.0,              // for progress
  "filesize": "1.49GiB",        // for progress (estimated, from yt-dlp output)
  "filepath": "...",            // for completion
  "error": "..."                // on failure
}
```

## Storage Schema

**chrome.storage.local keys:**

- `m3u8Urls` - Array of detected m3u8 URLs with metadata:
  ```javascript
  [{
    url: "https://...",               // original URL (used as storage key)
    effectiveUrl: "https://...",      // extracted inner URL for proxy URLs (used for display)
    urlWithoutQuery: "https://...without?params",
    mediaKind: "hls" | "dash" | "file", // HLS playlist, DASH manifest or progressive video file
    timestamp: "2025-10-25T...",
    tabId: 123,
    pageUrl: "https://page-url.com",
    checkResult: {
      success: true,
      formatId: "6864",
      resolution: "1920x1080",       // or "1920x1080 (?)" when guessed from URL
      filesize: "1.68GiB",           // null when unknown, updated from download progress
      unknownFilesize: false,         // true when filesize was not available at check time
      duration: 154,                  // seconds, from the HLS playlist; null when unknown
      downloadUrl: "https://...",     // master playlist URL if discovered, null otherwise; passed to yt-dlp for download
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
      downloadUrl: "https://...",     // URL the download was actually started with (master playlist or null); resume MUST reuse it — its formatId is only valid against this URL
      percent: 45.0,
      startedAt: "2025-10-25T..."
    }
  }
  ```

- `interruptedDownloads` - Map of downloads whose process died (host restart) or failed; same shape as `activeDownloads` plus `interruptedAt` and `lastError` (shown on the card). Filename is preserved so a resumed download continues from yt-dlp's `.part`/`.ytdl` files. When starting a download, popup.js matches interrupted entries both by exact URL and by URL-without-query (same video re-detected with a fresh token) — but only adopts the old filename if the resolution matches (fragments of different variants must not be mixed).

- `uiLogs` - Persistent event log shown on the popup's Logs tab (written ONLY by background.js to avoid read-modify-write races; writes are serialized through a promise chain). Capped at 300 entries. Each entry: `{ seq, time, text }` — `seq` is monotonically increasing so the popup can append only new entries on `chrome.storage.onChanged` (index-based tracking would break when the cap splices old entries). Logged events: download completed/failed/cancelled, check failures, native host disconnects. The Clear button in the popup clears this key too.

- `ytdlpSettings` - User configuration:
  ```javascript
  {
    ytdlpPath: "E:\\yt-dlp\\yt-dlp.exe",
    ytdlpOutput: "E:\\yt-dlp"
  }
  ```

## yt-dlp Integration

The native host uses yt-dlp (youtube-dl fork) for video downloading.

**Format Selection Algorithm** (`parseYtDlpOutput()` in `native-host/index.js`):
- Parses `yt-dlp --list-formats` output
- Selects highest resolution format by pixel count
- Extracts format ID, resolution, and file size
- Falls back to formats with unknown resolution (common for HLS)
- When resolution is unknown, tries master playlist discovery (`findMasterPlaylist()`) — probing sibling `playlist.m3u8`/`master.m3u8`/`index.m3u8`/`manifest.m3u8` names with the same query string — and re-checks against the master, selecting the specific variant the checked URL points to (via `targetResolution` parameter of `parseYtDlpOutput()`)
- Guesses resolution from URL patterns (e.g., `1080p` → `1920x1080 (?)`) as a last resort
- **Video-only formats**: when the selected format line shows `video only` in the ACODEC column (audio is a separate track — always the case on Cloudflare Stream), the returned format ID becomes `<id>+bestaudio/<id>` so yt-dlp muxes in the best audio track. Without this the download is silent. **Requires ffmpeg on PATH** for the merge step

**Download Progress Parsing** (`native-host/index.js`):
- Monitors stdout/stderr for `[download] XX.X%` patterns
- Extracts estimated filesize from progress output (e.g., `of ~ 1.49GiB`)
- Sends progress updates with filesize to extension in real-time
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
