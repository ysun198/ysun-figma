# ysun figma

**简体中文** | [English](README.en.md)

在 Codex 里读取、修改和导出 Figma 设计。直接发消息或用 `/` 命令调用，也可以打开专属的侧边栏工作台。

复制这句话发给 Codex：

```text
帮我安装 ysun figma：https://github.com/ysun198/ysun-figma
```

后续更新会自动安装。

目前支持 macOS，需要 Figma 桌面端。免费账号可用，本地操作不消耗官方远程 MCP 额度；Figma 的文件权限和套餐限制仍然适用。

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
