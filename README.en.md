<h1 align="center">ysun figma</h1>

<p align="center">
  <strong>Tell Codex what you have in mind. Let it build your design in Figma.</strong>
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

Mention **ysun figma** in your conversation or select the plugin with `/`. Read, edit and export Figma designs through regular tool calls.

The plugin currently supports macOS only and requires Figma Desktop. It reads and writes designs directly through the desktop app, with no local monthly quota or official MCP quota consumption. Available features still depend on Figma file permissions, editor support and plan eligibility.

Ordinary connection, reading, editing, readback and export use direct MCP calls without mouse or keyboard automation or an API token. Cloud authoring reuses the official Figma connection in Codex: use an existing grant, or sign in when the host requests it. No self-registered OAuth app or hosted backend is required for this workflow.

Direct REST, SCIM/Discovery and Embed API integrations remain optional. Check their separate credentials, app registration, permissions and quotas only when needed. The official connection does not supply credentials for direct REST requests.

Widget and Dev extensions use their actual entrypoints while sharing the native connection and operation journal. The [capability inventory](skills/ysun-figma/references/capabilities.md) separates implementation, live acceptance and account restrictions.

You can also ask Codex to research Figma Community templates directly: search, paginate, read details and inspect image previews without GUI automation.

## How to install

Copy this into Codex:

```text
Install ysun figma: https://github.com/ysun198/ysun-figma
```

Codex prepares the local prerequisites, connects your intended Figma file and verifies it with a real read. Existing sign-in is reused; first Figma sign-in or permission acceptance remains yours. A missing native manifest is imported once. Ordinary use needs no connection code.

Keep Codex Desktop and Figma Desktop updated to the latest versions.

## Contact and feedback

Contact the author at [981118963@qq.com](mailto:981118963@qq.com) with issues or suggestions, or submit a PR.

Learn more about [installation and updates](docs/INSTALL.md), [architecture](docs/ARCHITECTURE.md), [privacy and access](docs/PRIVACY.md) and [third-party notices](NOTICE.md).

## Support the author

<p align="center">If this plugin helped you, feel free to buy the author a coffee.</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ysun198/ysun-figma/main/docs/assets/wechat-sponsor.png" alt="WeChat payment QR code" width="240" />
  <br />
  WeChat（微信）
</p>

---

MIT licensed. Independently developed; not affiliated with Figma or OpenAI.
