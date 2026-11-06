# Meldrix Download Manager

Meldrix is a standalone Windows download manager built with Electron, React, TypeScript, and a SQLite database. React is bundled inside the Electron window. There is no website, cloud account, localhost dashboard, or permanent Node.js server.

## Architecture

```text
Chrome / Edge extension
        │  chrome.runtime.connectNative (4-byte length-prefixed JSON)
        ▼
MeldrixNativeHost.exe  (Node SEA, bundled)
        │  \\.\pipe\meldrix-download-manager
        ▼
Electron main process ── existing download engine ── SQLite
        │
        └── Add Download review dialog in the React UI
```

- The native host is a small Node Single Executable Application. Chrome/Edge launch it on demand and close it when the port disconnects. Desktop updates use content-addressed, side-by-side host binaries so Windows never needs to overwrite a native host that an open browser is still running.
- The bridge uses protocol version 2. Requests carry a per-message `id`, `version: 2`, a `type`, and browser/client metadata. Responses echo the request id and include `version`, `type`, `ok`, and a machine-readable error `code` on failure. Supported operations are `hello`, `ping`, `enqueue`, `show`, and `settings:update`.
- `hello` is the readiness handshake: the host launches the desktop if necessary and responds only after the Electron pipe is listening and the desktop confirms `desktopReady: true`. Enqueue retries are bounded, use a stable request ID, and are deduplicated by both extension and desktop. A browser download is cancelled only after the desktop acknowledges acceptance.
- The host allows a 20-second desktop startup budget with exponential backoff; extension request timeouts are configurable in `extension/background.js` and retries are capped at three attempts. A one-minute alarm rechecks the live bridge after MV3 worker suspension.
- The Electron main process owns all downloads, pause/resume, progress, SQLite history, notifications, tray behavior, and folder selection.
- The preload bridge keeps `contextIsolation: true` and `nodeIntegration: false`.
- Native Messaging is registered automatically by the installer and re-registered by the app on launch for the current user.

## Install

1. [Download the Setup installer](https://github.com/fahadmia20333/dawnload-manager/releases/download/v1.0.0/MeldrixDownloadManager-Setup.exe) (recommended).
2. [Download the Portable version](https://github.com/fahadmia20333/dawnload-manager/releases/download/v1.0.0/MeldrixDownloadManager-Portable.exe).
3. Open Meldrix → **Settings → Browser Integration → Open extension folder**.
4. In Chrome or Edge, open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `extension` folder.
5. Open the Meldrix toolbar popup. It shows **Connected to Meldrix** only after a real Native Messaging v2 readiness/health exchange.

For the portable build, copy the `extension` folder from the app's temporary resources to a permanent location before closing it, then load that copy unpacked. The Setup installer is recommended when browser integration is required.

The installer writes the Chrome and Edge registry keys:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.meldrix.downloadmanager
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.meldrix.downloadmanager
```

The app manifest is stored at:

```text
%APPDATA%\meldrix-download-manager\com.meldrix.downloadmanager.json
```

The active versioned native host copy is stored at:

```text
%APPDATA%\meldrix-download-manager\native-host\MeldrixNativeHost-<content-hash>.exe
```

The uninstaller removes the two registry keys, the manifest, and versioned native host copies. It does not delete download history or user files.

## Browser behavior

- Supports direct MP4, WebM, MOV, MKV, MP3, M4A, WAV, FLAC, ZIP, RAR, 7Z, EXE, MSI, PDF, DOC/DOCX, XLS/XLSX, and similar files.
- Detects normal browser downloads with `chrome.downloads.onCreated`, network responses with `webRequest`, and page media through a content script.
- Browser downloads are paused first. The original browser download is cancelled only after the desktop app returns a real `accepted` response. If the request fails, the browser download resumes.
- Duplicate browser retries use request IDs and are deduplicated in the extension and desktop app. Concurrent requests for an already-pending review focus that review rather than creating another task.
- The desktop Add Download dialog shows the detected filename, size, category, and destination. **Add to queue** keeps the task queued; **Download now** starts it immediately.
- When **Confirm before downloading** is disabled in desktop settings, requests start immediately without the dialog.
- HLS VOD streams can be selected by real discovered variant (resolution, bandwidth, codecs) and downloaded by the Electron engine. Unencrypted `m3u8` playlists are supported; encrypted (`EXT-X-KEY`), DRM, and live streams are rejected with an explicit error.
- Progressive DASH renditions with a direct `BaseURL` are detected. Segmented DASH requires muxing and is reported as unsupported rather than pretending to download.
- The extension never harvests blanket cookies, authorization headers, or browser session storage. Only the page referrer, filename, MIME type, size, and selected media URL are sent. Referrer is forwarded to the download engine for authorized CDN requests.

## Settings

Desktop **Settings → Browser Integration** shows real state:

- Chrome / Edge installed, native host registered, connected (based on a recent real message from that browser), or error.
- Native host path, manifest path, manifest validity, and last extension contact.
- Toggles for automatic detection, video button, confirm-before-download, and start-with-Windows.
- Extension folder shortcut and a status re-check action.

Extension popup toggles write the same settings back to the desktop app. No hardcoded “Connected” state is used.

## Menus and task actions

- **File:** New Download (`Ctrl+N`), open the configured download folder, and Settings.
- **Tasks:** open a selected task, view details (`Alt+Enter`), pause/resume/stop selected tasks, start/stop the queue, select visible tasks (`Ctrl+A`), and delete selected task records (`Delete`). Hold **Ctrl** while clicking a task row to multi-select. Delete asks for confirmation; completed and partial files are retained.
- **Tools:** open the download folder or extension folder and open browser integration/general settings.
- **Help:** open the project repository, the bundled local README, the repository issue form, About, and Check for Updates. Automatic updates are not configured, so the update item explains that limitation rather than claiming it checked.
- The toolbar and menus share the same queue, pause/resume, settings, and delete operations. Completed tasks open their local file; unfinished tasks open their source URL.

## Build

```bash
npm install
npm run build-native-host
npm run dist
```

`npm run dist` rebuilds the native host, builds the renderer, and runs electron-builder. It produces:

```text
release/MeldrixDownloadManager-Setup.exe
release/MeldrixDownloadManager-Portable.exe
```

Development mode still exists for UI work (`npm run dev`), but it is not required for browser integration. In development, the native host and registry entries can be written with `npm run native-host`.

## Verification performed (previous packaged build)

- Packaged app starts, creates the Native Messaging pipe, and registers Chrome and Edge for the fixed extension ID.
- Native host protocol smoke test returned a real `pong` with current settings.
- Native `enqueue` returned `accepted` with `status: "review"`, opened a prefilled Add Download dialog, and created no database row before confirmation.
- A second identical enqueue was deduplicated; native `show` focused the desktop window.
- Launch recovery: with the desktop closed, a native `ping` started the app and returned `pong` in about 1.5 seconds.
- Stable host upgrade: after a host replacement, the old running host briefly locked the file (`EBUSY`), the app retried, and the stable copy was updated to the new binary without user action.
- HLS engine test used a local DRM-free playlist with two segments; the task completed and produced a 3000-byte `.ts` file.
- One-click row tests on the packaged app used a throttled local server:
  - 100 MB MP4 acceptance test: paused at about 19.9 MB by clicking the file cell, the transferred byte count stayed constant while paused, resume used the exact partial-file size, and the download completed at exactly 100,000,000 bytes.
  - 8 MB MP4 paused/resumed with **Enter**, 2 MB ZIP with **Space**, and 2 MB PDF with the mouse; every file completed at its exact expected size.
  - Resume continued from the partial file using a Range request, and the three-dot menu opened without changing download state.
- Automated Chrome 156 and Edge 156 tests loaded the unpacked extension, confirmed the service worker, and verified:
  - The popup showed **Connected to Meldrix** from a real Native Messaging health response.
  - An HLS master playlist exposed four real variants (1080p, 720p, 360p, audio-only).
  - `enqueue` returned a real `review` acknowledgement through the browser → native host → Electron path.
  - The floating Meldrix button appeared on an HTML5 video page.
  - The desktop Add Download dialog opened with the correct URL and filename prefilled, and no task row existed before confirmation.
- The installer payload was extracted and verified to contain the current `app.asar`, extension files, and native host binary.

These browser tests used local test media and Chrome/Edge automation. Third-party DRM-protected, paywalled, or cookie-bound media was not tested because Meldrix intentionally does not bypass those controls.

## Limitations

- DRM, encrypted HLS, live HLS, paywalled media, and access-controlled streams are rejected with an explicit error. Meldrix does not bypass them.
- Segmented DASH requires muxing and is reported as unsupported. Only progressive DASH renditions with a direct `BaseURL` can be downloaded.
- HLS segments are concatenated into a `.ts` or `.mp4` file without remuxing. Some players may not seek in the result, and pausing an HLS download resumes that stream from the beginning.
- Direct files expose their real source quality. A single-quality source is shown as **Original quality**; no invented variants are displayed.
- The extension forwards only the selected media URL, filename, MIME type, size, referrer, and quality label. It does not forward cookies, authorization headers, or session storage.
- The installer is unsigned, so Windows SmartScreen may warn on first run.

## Troubleshooting

- **Popup says Meldrix is not running:** the popup attempts recovery automatically. If Native Messaging is not registered, reinstall Meldrix and reload the extension.
- **“Native Messaging host is not registered”:** reinstall Meldrix, then remove and re-add the unpacked extension. Check the two registry keys above.
- **“Extension ID is not allowed”:** the extension must be loaded with the bundled manifest, which contains the fixed `key`. Do not edit the key or `allowed_origins`.
- **Connected in desktop but not popup:** use **Reconnect** as a secondary action. The popup performs a real health request; it does not read a cached badge.
- **A video shows no download button:** the page may use `blob:` media, DRM/EME, or a protected stream. Start playback to expose an HLS/DASH playlist, then reopen the popup. Protected media is intentionally not bypassed.
- **HLS fails:** live playlists, encrypted playlists, and manifest URLs that require cookies are rejected. Meldrix does not bypass authentication or access controls.
- **Logs:** `%APPDATA%\meldrix-download-manager\logs\main.log`

The installer is currently unsigned; Windows SmartScreen may warn on first run.
#   d a w n l o a d - m a n a g e r  
 