# ysun figma

[简体中文](README.md) | **English**

Read, edit and export Figma designs in Codex, with a live preview in the sidebar.

Send Codex [this repository's URL](https://github.com/ysun198/ysun-figma) and ask: “Install ysun figma and connect it to Figma.” Future releases install automatically.

Currently available for macOS and requires Figma Desktop. Free accounts are supported. Local operations do not consume the official remote MCP quota; Figma's file permissions and plan restrictions still apply.

## Develop

Development requires Node.js 24 or later. Run these commands from the repository directory:

```sh
npm ci           # Install development tools
npm test         # Run tests
npm run check    # Check formatting, code issues and build output
```

The interface and code that runs inside Figma live in `src/`. Connection, installation and update logic live in `scripts/`. Instructions for Codex live in `skills/`. Run the tests and checks again after making changes; `npm run format` fixes code formatting automatically.

To publish a new version, update the version number, push your changes to GitHub and run the **Publish release** workflow in GitHub Actions. It checks, packages and publishes the release. See [installation and updates](docs/INSTALL.md#发布) for signing configuration.

Further documentation is primarily in Chinese: [installation](docs/INSTALL.md), [architecture](docs/ARCHITECTURE.md), [privacy](docs/PRIVACY.md) and [third-party notices](NOTICE.md). License texts remain in their original language.

MIT licensed. Independently developed; not affiliated with Figma or OpenAI.
