# ysun figma

**简体中文** | [English](README.en.md)

**把想法说给 Codex，让它在 Figma 里做出来。**

在对话里提到 **ysun figma**，或用 `/` 选择插件；也可以在 Codex 侧边栏预览设计。

复制这句话发给 Codex：

```text
帮我安装 ysun figma：https://github.com/ysun198/ysun-figma
```

插件目前仅支持 macOS，需要安装 Figma 桌面端。通过桌面端直接读写设计，本地操作不限次数，免费 Figma 账号也能无限使用，不消耗官方 MCP 额度。

## 开发

开发需要 Node.js 24 或更高版本。在仓库目录运行：

```sh
npm ci           # 安装开发工具
npm test         # 运行测试
npm run check    # 检查代码格式、代码问题和构建结果
```

界面和 Figma 内运行的代码在 `src/`，连接、安装和更新逻辑在 `scripts/`，给 Codex 的任务指引在 `skills/`。改完后重新运行测试和检查；`npm run format` 可以自动整理代码格式。

发布新版本时，先更新版本号并把修改提交到 GitHub，再运行 GitHub Actions 的 **Publish release** 工作流。它会完成检查、打包和发布；发布签名的配置见[安装与更新](docs/INSTALL.md#发布)。

进一步了解[安装与更新](docs/INSTALL.md)、[架构](docs/ARCHITECTURE.md)、[隐私与访问](docs/PRIVACY.md)和[第三方声明](NOTICE.md)。

采用 MIT 许可证。独立开发，与 Figma 或 OpenAI 无隶属关系。
