# 安装与更新

日常安装只需把[仓库链接](https://github.com/ysun198/ysun-figma)发给 Codex。本页记录首次接入和发布时需要的细节，供 Codex 与维护者查阅。

## 首次接入

由 Codex 下载最新已发布版本的 ZIP，核对随包提供的 `SHA256SUMS`，解压到稳定目录，再注册插件：

```sh
codex plugin marketplace add /absolute/extracted/directory --json
codex plugin add figma-plugin-local@figma-local --json
```

保留其他插件和配置。如果 `figma-local` 已注册到不同目录，只移除它自己的旧注册，再添加新路径：`codex plugin marketplace remove figma-local --json`。

调用 `figma_connect`，在 Figma 桌面端导入返回的 `manifestPath`，运行 **ysun figma → Connect**，填入一次性连接码。已导入的 manifest 和有效授权应直接复用。为该开发插件开启 **Plugins → Development → Hot reload plugin**，让原生代码更新后能重新连接。

用 `figma_status` 核对目标文件和客户端。云文件绑定必须来自实际打开的文件 URL，不能按标题匹配。安装、运行插件和连接由 Codex 借助原生应用自动化完成；自动化不可用时，说明还缺少哪一步。

目前仅支持 macOS，需要已登录的 Figma 桌面端。原生 Plugin API 在已打开的文件和运行中的插件内执行；账号目录发现还需要已登录的 ego-browser。发行包自带 Node.js，无需用户另行安装。Apple Silicon 已完成实机验收；Intel 包含对应运行时，尚未完成实机验收。

## 自动更新

插件在启动时检查更新，后台每 60–75 分钟检查一次；打开新会话会唤醒检查，15 分钟内的正常检查会合并。Codex 关闭时，当前用户的 macOS 更新服务仍会运行。离线时继续使用已验证的版本；禁用或卸载插件后，服务在下一次宿主检查时停止。

更新先验证发布者签名和文件完整性，等操作空闲后再切换。启动检查失败会回滚，授权、操作记录和导出文件保留。调度、校验与恢复的实现见[架构](ARCHITECTURE.md#自动更新)。

工作台和技能随安装包更新。原生代码通过 [Figma 热重载](https://developers.figma.com/docs/plugins/plugin-quickstart-guide/#hot-reloading)更新；未变化的原生内核无需重启。重启后由 Codex 核验实际文件 URL，恢复确切的云文件绑定。manifest 的权限或编辑器类型变化时，重新导入同一个稳定 manifest。

源码提交不会推送更新。维护者运行 **Publish release** 工作流后，完整的签名发行版才会公开。宿主安装命令见 [OpenAI 本地插件指南](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually)。

## 发布

首次发布前，在仓库的 Actions secrets 中配置 `RELEASE_SIGNING_KEY`，其公钥必须与 `package.json` 中的 `updates.publicKey` 一致。私钥保存在仓库之外。

更新版本号，例如运行 `npm version patch --no-git-tag-version`，提交并推送修改，再到 GitHub Actions 运行 **Publish release**。工作流会运行测试和检查，生成、签署并发布安装包。

只需在本地生成发行包时，运行 `FIGMA_RELEASE_KEY_FILE=/absolute/private/key.pem npm run release`。它不会发布到 GitHub。宿主集成测试需要本机安装 Codex。
