# ysun figma

**简体中文** | [English](README.en.md)

在 Codex 中通过本地原生 Plugin API 读取、编辑和导出 Figma 文件。本地执行不消耗官方远程 MCP 额度，文件权限和 Figma 套餐限制仍然适用。

## 使用

把[最新发行包 ZIP](https://github.com/ysun198/ysun-figma/releases/latest)交给 Codex，让它安装并连接。macOS 发行包自带 Node.js；Codex 可以通过可用的桌面自动化导入、启动原生插件并完成配对。保存授权后，后续连接会自动恢复。

已发布的更新会自动接收，无需点击更新按钮。本地接收器在启动时和后台约每小时检查一次，验证发布者签名后，在执行空闲时切换到通过健康检查的版本。近期检查会合并，网络失败会自动退避重试。授权、执行记录和设计留在本地；普通源码提交不会推送插件更新。

保持 Figma 桌面端和原生插件运行，在当前 Codex 会话中发出指令。侧边栏工作台提供按名称搜索、卡片与列表视图，以及实时整页图像预览；设计变化时会保留预览的平移和缩放。编辑、图层选择和原型播放在 Figma 桌面端完成。

账号目录通过已登录的 Figma 浏览器和 ego-browser 获取，依赖 Figma 文件浏览器的实现。Figma 没有提供公开的账号全量文件列表 API。缺少浏览器适配器时，已连接的原生文件仍可使用，已保存的目录仍可查看。

九项技能覆盖文件、设计、原型、FigJam、Slides、设计系统、动效和设计转代码，共用同一个原生执行环境和固定版本的 Figma API 参考。API 参考采用 MIT 许可证。

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
