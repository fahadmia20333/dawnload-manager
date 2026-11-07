# Meldrix Native Messaging host

The Chrome/Edge Native Messaging executable implements bridge protocol v2. It accepts four-byte little-endian length-prefixed JSON frames, validates each request, and returns a correlated response containing `version`, `id`, `type`, and `ok`. It forwards requests to the Electron app over newline-delimited JSON on `\\.\pipe\meldrix-download-manager`.

Supported operations: `hello` (desktop readiness), `ping`, `enqueue`, `show`, and `settings:update`. The host starts Meldrix if needed, waits up to 20 seconds for an actual desktop response, and uses bounded exponential retry. It never acknowledges an enqueue until the desktop acknowledges it.

Build with `npm run build-native-host` from the repository root. The Windows installer generates separate Chrome and Edge manifests from `extension-origins.json`; each browser manifest must allow the corresponding extension ID. When a store-issued ID differs from the development ID, update the browser manifest's public signing key and the matching configured origin before publishing a new desktop build.
