# ysun figma

[简体中文](README.md) | **English**

Read, edit and export Figma files from Codex through the local, native Plugin API. Local execution does not consume the official remote MCP quota. Figma's file permissions and plan restrictions still apply.

## Use

Currently available for macOS. Install Codex and Figma Desktop, then sign in to your Figma account.

1. **Install the plugin**: Download the ZIP from the [latest release](https://github.com/ysun198/ysun-figma/releases/latest), then tell Codex: “Install the ysun figma plugin I just downloaded and connect it to Figma.”
2. **Change your design**: Open the file in Figma Desktop and describe what you want in your Codex conversation. For example: “Use ysun figma to make this page dark and add a login dialog.” Changes are written directly to that Figma file.
3. **See the result**: Open ysun figma in the Codex sidebar and select the file. The preview updates as your design changes. You can also view the result in Figma Desktop.

Keep Figma Desktop and its ysun figma plugin running while you work. Use Figma Desktop for manual editing and prototype playback. Future releases install automatically.

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
