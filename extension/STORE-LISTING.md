# Store listing draft

## Short description

Capture supported browser downloads and send them to the Meldrix Windows desktop download manager.

## Full description

Meldrix connects your browser to the Meldrix Download Manager for Windows using browser Native Messaging. You can hand off supported HTTP/HTTPS downloads, review detected direct media, and choose whether supported downloads are captured automatically. Settings are stored locally in the browser.

The extension does not bypass DRM, paywalls, authentication, or access controls. It does not collect cookies, passwords, or session tokens. The Windows desktop application must be installed for download handoff.

## Permissions rationale

- `nativeMessaging`: communicate with the installed Meldrix desktop host.
- `downloads`: observe and pause supported browser downloads until the desktop confirms a handoff; resume the browser download if handoff fails.
- `webRequest` and `<all_urls>`: identify response content types, attachment filenames, and direct media/manifests on websites. The extension cannot reliably discover cross-origin player media with narrower host access.
- `scripting`, `tabs`: inject the bundled control on HTTP/HTTPS tabs and associate discovered sources with the active tab.
- `storage`: persist opt-in capture preferences locally.
- `contextMenus`: provide an explicit “Download with Meldrix” action.
- `alarms`: recover Native Messaging health after service-worker suspension.

## Publication readiness

The Chrome Web Store and Microsoft Edge Add-ons listings are not published. Store-issued extension IDs, final store policy review, screenshots, promotional artwork, and a production privacy-policy URL must be supplied before submission. The current development signing key is retained for local identity; store packaging and signing must follow each store's current process.
