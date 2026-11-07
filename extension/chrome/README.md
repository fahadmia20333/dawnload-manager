# Meldrix for Chrome

The Chrome-specific manifest lives in this directory. `npm run build:chrome` assembles the shared extension implementation, documentation, and icons into `dist/extensions/chrome/unpacked` and creates a root-manifest ZIP at `dist/extensions/chrome/Meldrix-Chrome-Extension.zip`.

For local testing, load the unpacked folder at `chrome://extensions` with Developer mode enabled. Install Meldrix Desktop first so its Native Messaging Host can be registered. The Chrome Web Store listing is not published; this package is not represented as store-approved.

Store listing and permission rationale: [STORE-LISTING.md](./STORE-LISTING.md). Privacy: [PRIVACY.md](./PRIVACY.md).
