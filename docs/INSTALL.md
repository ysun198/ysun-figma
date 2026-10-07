# 安装与更新

把[仓库链接](https://github.com/ysun198/ysun-figma)发给 Codex，让它安装并连接 Figma。以下细节供 Codex 和维护者参考。

由 Codex 下载最新已发布版本的 ZIP，核对随包提供的 `SHA256SUMS`，解压到稳定目录，然后注册本地插件市场并启用插件：

```sh
codex plugin marketplace add /absolute/extracted/directory --json
codex plugin add figma-plugin-local@figma-local --json
```

保留其他插件和配置。如果 `figma-local` 已注册到不同目录，先用 `codex plugin marketplace remove figma-local --json` 移除它自己的旧注册，再注册新路径。

调用 `figma_connect`。借助原生应用自动化，在 Figma 桌面端导入返回的稳定 manifest（如果尚未导入），运行 **ysun figma → Connect**，输入一次性配对码。为该开发插件开启 Figma 的 **Plugins → Development → Hot reload plugin**。用 `figma_status` 验证确切的文件和客户端；已有有效授权应复用，重新打开插件后会自动恢复。云文件绑定必须来自实际打开的文件 URL，不能按标题匹配。

原生 Plugin API 需要已打开的文件和正在运行的插件，没有无界面安装或账号全量编辑接口。Figma 桌面端需要登录；账号目录发现还需要已登录的 ego-browser。自动化不可用时，明确说明剩余的具体操作。

发行包自带 Node.js，用户无需另行安装。包含适用于 Apple Silicon 和 Intel macOS 的官方二进制；Apple Silicon 已完成实机验收，Intel 实机尚未验收。

## 自动更新

安装后的启动器注册当前用户的 macOS LaunchAgent `com.ysun.figma.updates`。接收器在启动时检查更新，之后每 60–75 分钟检查一次，Codex 关闭时也会运行。打开新会话会唤醒接收器；两次正常检查之间有 15 分钟冷却时间。HTTP 条件请求复用已验证签名的发布描述，网络失败采用带随机错峰的指数退避，服务端 `Retry-After` 指定的等待时间会跨进程重启保留。离线时继续使用最后验证通过的代码。禁用或卸载插件后，接收器会在下一次宿主检查时停止。

接收器验证 Ed25519 签名、压缩包哈希和精确的公开文件白名单。排队或执行中的操作会阻止切换；重试切换前会重新核对发布状态，清理已撤回或被新版替代的候选更新。新包原子切换后执行启动探测，失败则回滚；启动探测失败的压缩包会被拒绝，等待发布者提供不同的发行包。私有授权、回执、目录和导出文件保留。正常并发启动只验证文件。宿主元数据和技能通过官方 `codex plugin add` 命令刷新；活跃连接通知工具与资源变化，已打开的工作台通过 MCP Apps 资源桥加载当前界面。

原生构建标识由代码内容决定，与包版本独立。界面或技能更新不会重启未变化的原生内核。实际内核变更通过 [Figma 热重载](https://developers.figma.com/docs/plugins/plugin-quickstart-guide/#hot-reloading)重启并恢复授权。新原生实例必须从实际打开的文件 URL 重新验证云文件绑定，由 agent 完成核验。权限或编辑器类型发生变化时，重新导入稳定 manifest。

源码提交本身不会更新用户的插件。维护者通过 **Publish release** 工作流选择发布；所有签名资源准备完成后，草稿发行版才会公开。[OpenAI 本地插件指南](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually)说明了官方宿主安装命令。

## 发布

发布前更新版本号，例如运行 `npm version patch --no-git-tag-version`，再把修改提交到 GitHub。在 Actions 页面运行 **Publish release** 工作流，它会检查代码、打包、签名并发布新版本。

首次配置发布时，在仓库的 Actions secrets 中添加 `RELEASE_SIGNING_KEY`，其公钥必须与 `package.json` 中的 `updates.publicKey` 一致。私钥应保存在仓库之外。

需要在本地生成发行包时，运行 `FIGMA_RELEASE_KEY_FILE=/absolute/private/key.pem npm run release`。它会先运行测试和检查，再生成发行包；不会发布到 GitHub。测试宿主相关功能时，需要安装 Codex。
