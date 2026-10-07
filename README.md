# ysun figma

**简体中文** | [English](README.en.md)

在 Codex 中通过本地原生 Plugin API 读取、编辑和导出 Figma 文件。本地执行不消耗官方远程 MCP 额度，文件权限和 Figma 套餐限制仍然适用。

## 使用

目前支持 macOS。先装好 Codex 和 Figma 桌面端，并登录你的 Figma 账号。

1. **安装插件**：下载[最新版本](https://github.com/ysun198/ysun-figma/releases/latest)中的 ZIP 文件，在 Codex 里说：“帮我安装刚下载的 ysun figma 插件，并连接 Figma。”
2. **修改设计**：在 Figma 桌面端打开要修改的文件，在 Codex 对话里说出需求，比如：“用 ysun figma 把这个页面改成深色，再加一个登录弹窗。”设计会直接写入这个 Figma 文件。
3. **查看结果**：在 Codex 侧边栏打开 ysun figma，选择这个文件。你一边聊天，预览会随设计修改自动更新；也可以直接在 Figma 桌面端查看。

使用时保持 Figma 桌面端和其中的 ysun figma 插件运行。手动编辑和播放原型在 Figma 桌面端完成。后续发布的新版本会自动更新。

## 开发

需要 Node.js 24 或更新版本。发行包运行时不依赖 npm 安装。

```sh
npm ci
npm test
npm run check
FIGMA_RELEASE_KEY_FILE=/absolute/private/key.pem npm run release
```

`npm run format` 格式化源码。测试覆盖执行、恢复、身份、传输、界面和打包；宿主相关检查需要安装 Codex。发行包经过公开内容审计，包含适用于 Apple Silicon 和 Intel macOS 的官方 Node.js 二进制。Apple Silicon 已完成实机验收，Intel 实机尚未验收。

维护者通过 GitHub Actions 的 **Publish release** 工作流选择发布。私有 `RELEASE_SIGNING_KEY` 必须与 `package.json` 中的公钥匹配；工作流完成签名和全部资源上传后，才向已安装的客户端开放更新。

进一步了解[安装与更新](docs/INSTALL.md)、[架构](docs/ARCHITECTURE.md)、[隐私与访问](docs/PRIVACY.md)和[第三方声明](NOTICE.md)。

采用 MIT 许可证。独立开发，与 Figma 或 OpenAI 无隶属关系。
