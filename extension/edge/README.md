# Meldrix for Microsoft Edge

The Edge-specific manifest lives in this directory. `npm run build:edge` assembles the shared extension implementation, documentation, and icons into `dist/extensions/edge/unpacked` and creates a root-manifest ZIP at `dist/extensions/edge/Meldrix-Edge-Extension.zip`.

For local testing, load the unpacked folder at `edge://extensions` with Developer mode enabled. Install Meldrix Desktop first so its Native Messaging Host can be registered. The Microsoft Edge Add-ons listing is not published; this package is not represented as store-approved.

Store listing and permission rationale: [STORE-LISTING.md](./STORE-LISTING.md). Privacy: [PRIVACY.md](./PRIVACY.md).
