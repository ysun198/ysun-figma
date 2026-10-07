# ysun figma

[简体中文](README.md) | **English**

Read, edit and export Figma files from Codex through the local, native Plugin API. Local execution does not consume the official remote MCP quota. Figma's file permissions and plan restrictions still apply.

## Use

Give Codex the [latest release ZIP](https://github.com/ysun198/ysun-figma/releases/latest) and ask it to install and connect. The macOS package includes its Node.js runtime. Codex can import, launch and pair the native plugin through available app automation; saved authorization reconnects automatically.

Published releases arrive automatically, without an update button. A local receiver checks at startup and about hourly in the background, verifies the publisher's signature and activates healthy code while execution is idle. Recent checks are coalesced; network failures back off automatically. Authorization, operation records and designs stay local. Ordinary source pushes do not publish an update.

Keep Figma Desktop and the native plugin running. Use your existing Codex conversation for commands, and open the sidebar workbench for name search, card/list views and live page previews. The preview preserves pan and zoom while native changes arrive. Editing, layer selection and prototype playback happen in Figma Desktop; the sidebar is a raster preview, not an embedded editor.

Account discovery uses the authenticated Figma browser through ego-browser. It depends on Figma's file-browser implementation, not a public account-list API. Without that adapter, connected native files remain usable and the saved directory remains visible.

Nine focused skills cover files, design, prototypes, FigJam, Slides, design systems, motion and design-to-code. They share one native execution environment and a pinned, MIT-licensed Figma API reference.

## Develop

Requires Node.js 24 or later. Runtime packages have no npm dependencies.

```sh
npm ci
npm test
npm run check
FIGMA_RELEASE_KEY_FILE=/absolute/private/key.pem npm run release
```

`npm run format` formats the source. Tests cover execution, recovery, identity, transport, interfaces and packaging; host-specific checks need Codex installed. Release builds produce an audited ZIP with official Node.js binaries for Apple Silicon and Intel macOS. Apple Silicon has live acceptance; physical Intel acceptance remains unverified.

The maintainer publishes through the GitHub Actions **Publish release** workflow. Its private `RELEASE_SIGNING_KEY` must match the public key in `package.json`. The workflow signs and uploads all assets before making a release available to installed clients.

Further documentation is primarily in Chinese: [installation](docs/INSTALL.md), [architecture](docs/ARCHITECTURE.md), [privacy](docs/PRIVACY.md) and [third-party notices](NOTICE.md). License texts remain in their original language.

MIT licensed. Independently developed; not affiliated with Figma or OpenAI.
