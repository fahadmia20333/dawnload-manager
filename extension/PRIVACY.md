# Meldrix Browser Extension Privacy

The extension uses Chrome/Edge Native Messaging to send user-approved download requests to the Meldrix desktop application. Requests contain the HTTP/HTTPS URL, suggested filename, MIME type, and browser referrer when supplied by the browser. The desktop app stores download history locally.

The extension does not collect or transmit cookies, passwords, authentication tokens, page text, or browsing history to Meldrix servers. Browser request observation is used to identify supported download and media responses. It is not used to bypass authentication, DRM, paywalls, or other access controls.

No extension store listing or remote analytics endpoint is configured in this repository. Extension preferences are stored locally by the browser.

Users must have authorization to download content. Media detection and HLS handling are limited by browser, website, and desktop-engine capabilities.
