<h1 align="center">ysun figma</h1>

<p align="center">
  <strong>把想法说给 Codex，让它在 Figma 里做出来。</strong>
</p>

<p align="center">
  <strong>简体中文</strong> | <a href="README.en.md">English</a>
</p>

在对话里提到 **ysun figma**，或用 `/` 选择插件。通过普通工具调用读取、编辑和导出 Figma 设计。

插件目前仅支持 macOS，需要安装 Figma 桌面端。通过桌面端直接读写设计，本地调用不设月度额度，不消耗官方 MCP 额度；具体能力仍受 Figma 文件权限、编辑器和套餐限制。

日常工作默认直接连接、读取、写入、读回和导出，不需要模拟鼠标键盘，也不需要 API 令牌。云端创作复用 Codex 中的 Figma 官方连接，已有授权直接使用，未连接时按宿主提示登录授权。无需自行创建 OAuth 应用或部署服务器。

另保留直接 REST、SCIM/Discovery 与 Embed API 等可选接口；需要这些能力时再检查各自的凭据、应用注册、权限和额度。官方连接不代替直接 REST 的凭据。

Widget 与 Dev 扩展使用各自真实运行入口，与普通设计操作共用连接和操作记录。[能力表](skills/ysun-figma/references/capabilities.md)分别记录已实现、实机验证和账号权限边界。

## 怎么安装

复制这句话发给 Codex：

```text
帮我安装 ysun figma：https://github.com/ysun198/ysun-figma
```

请将 Codex 桌面端和 Figma 桌面端更新至最新版本。

## 联系与反馈

欢迎通过 [981118963@qq.com](mailto:981118963@qq.com) 联系作者反馈问题和建议，或提交 PR。

进一步了解[安装与更新](docs/INSTALL.md)、[架构](docs/ARCHITECTURE.md)、[隐私与访问](docs/PRIVACY.md)和[第三方声明](NOTICE.md)。

## 支持作者

<p align="center">如果这个插件帮到了你，欢迎请作者喝杯咖啡。</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ysun198/ysun-figma/main/docs/assets/wechat-sponsor.png" alt="微信收款二维码" width="240" />
  <br />
  微信
</p>

---

采用 MIT 许可证。独立开发，与 Figma 或 OpenAI 无隶属关系。
