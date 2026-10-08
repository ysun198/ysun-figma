# 安装与更新

日常安装只需把[仓库链接](https://github.com/ysun198/ysun-figma)发给 Codex。本页记录首次接入和发布时需要的细节，供 Codex 与维护者查阅。

## 首次接入

Codex 先检查 Node.js 24 或更高版本，优先复用已有运行时。插件会检查指定的 `FIGMA_PLUGIN_NODE`、PATH、Homebrew 常见路径和 `~/.canvas-bridge/node/bin/node`；不假定每台安装 Codex 的电脑都已安装 Node.js。

缺少运行时时，由 Codex 从 [Node.js 官方发布目录](https://nodejs.org/download/release/latest-v24.x/)下载适合当前 Mac 架构的 Node.js 24 LTS，核对官方 `SHASUMS256.txt` 和二进制代码签名，将 `bin/node` 和许可证放入 `~/.canvas-bridge/node/`。无需管理员权限，也无需为运行插件安装 npm 开发依赖。使用其他稳定路径时，在 MCP 环境中指定 `FIGMA_PLUGIN_NODE`。

未安装 Figma 桌面端时，插件返回 `desktop_required`，工作台提示让 Codex 安装。Codex 从 [Figma 官网](https://www.figma.com/downloads/)下载当前稳定版，核验代码签名后安装；可放在 `~/Applications/Figma.app`，无需管理员密码。首次使用 Figma 的用户仍需完成 Figma 自己的登录，已登录的账号直接复用。安装和登录完成后继续连接，无需重装插件。

然后下载最新已发布版本的 ZIP，核对随包提供的 `SHA256SUMS`，解压到稳定目录，再注册插件：

```sh
codex plugin marketplace add /absolute/extracted/directory --json
codex plugin add figma-plugin-local@figma-local --json
```

保留其他插件和配置。如果 `figma-local` 已注册到不同目录，只移除它自己的旧注册，再添加新路径：`codex plugin marketplace remove figma-local --json`。

调用 `figma_connect`，在 Figma 桌面端导入返回的 `manifestPath`，运行 **ysun figma → Connect**，填入一次性连接码。已导入的 manifest 和有效授权应直接复用。为该开发插件开启 **Plugins → Development → Hot reload plugin**，让原生代码更新后能重新连接。

用 `figma_status` 核对目标文件和客户端。云文件绑定必须来自实际打开的文件 URL，不能按标题匹配。安装、运行插件和连接由 Codex 借助原生应用自动化完成；自动化不可用时，说明还缺少哪一步。

目前仅支持 macOS，需要 Figma 桌面端。账号目录复用桌面端自己的登录会话；不再依赖 ego、Chrome 或其他外部浏览器，也不读取钥匙串或复制 Cookie。缺少 Node.js 时由 Codex 完成安装。Node.js 24 官方运行时要求 [macOS 13.5 或更高版本](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md#platform-list)。

首次连接由 Codex 通过 `figma_file(action="launch")` 启动 Figma。若 Figma 已由 Dock 等方式启动，返回 `desktop_restart_required`：Codex 先检查并保存待同步设计，再正常退出 Figma，通过同一工具重新打开，复用原有账号登录。不可强制退出有未同步修改的编辑器。之后桌面端保持运行，插件更新、Codex 关闭或连接进程退出都不会退出 Figma。Figma 完全退出后，再从插件启动即可恢复；从 Dock 单独启动的进程仍需安全重连。

桌面端的账号目录通过 Figma Home 当前内部目录接口读取，并非公开的账号全量 REST API。版本变化或组织权限可能使同步不可用；它不改变原生插件的读写授权，已连接文件仍可编辑和实时预览。

请将 Codex 桌面端和 Figma 桌面端更新至最新版本。2026-10-08 核对的实机环境为 Apple Silicon、macOS 27.0.1、Codex 26.1002.51308（内置 CLI 0.162.0-alpha.2）、Figma 126.9.13，插件版本为 0.27.1。旧版桌面端尚未建立兼容测试矩阵，因此不声明最低支持版本。Intel 尚未完成实机验收。

## 自动更新

插件在启动时检查更新，后台每 60–75 分钟检查一次；打开新会话会唤醒检查，15 分钟内的正常检查会合并。Codex 关闭时，当前用户的 macOS 更新服务仍会运行。离线时继续使用已验证的版本；禁用或卸载插件后，服务在下一次宿主检查时停止。

更新先验证发布者签名和文件完整性，等操作空闲后再切换。启动检查失败会回滚，授权、操作记录和导出文件保留。调度、校验与恢复的实现见[架构](ARCHITECTURE.md#自动更新)。

工作台和技能随安装包更新。原生代码通过 [Figma 热重载](https://developers.figma.com/docs/plugins/plugin-quickstart-guide/#hot-reloading)更新；未变化的原生内核无需重启。重启后由 Codex 核验实际文件 URL，恢复确切的云文件绑定。manifest 的权限或编辑器类型变化时，重新导入同一个稳定 manifest。

源码提交不会推送更新。维护者运行 **Publish release** 工作流后，完整的签名发行版才会公开。宿主安装命令见 [OpenAI 本地插件指南](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually)。

## 发布

首次发布前，在仓库的 Actions secrets 中配置 `RELEASE_SIGNING_KEY`，其公钥必须与 `package.json` 中的 `updates.publicKey` 一致。私钥保存在仓库之外。

更新版本号，例如运行 `npm version patch --no-git-tag-version`，提交并推送修改，再到 GitHub Actions 运行 **Publish release**。工作流会运行测试和检查，生成、签署并发布安装包。

只需在本地生成发行包时，运行 `FIGMA_RELEASE_KEY_FILE=/absolute/private/key.pem npm run release`。它不会发布到 GitHub。宿主集成测试需要本机安装 Codex。
