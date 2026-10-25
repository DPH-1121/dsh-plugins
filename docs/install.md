# DSH 插件安装教程

本页是 DPH-1121 的 DSH 插件统一安装说明，适用于下面四个仓库，也适用于其他从 GitHub 安装的 DSH 插件（把 `owner/repo` 换成对应仓库即可）。

| 插件 | 安装地址 |
|---|---|
| [dsh-opencode-go-plus](https://github.com/DPH-1121/dsh-opencode-go-plus) | `github:DPH-1121/dsh-opencode-go-plus` |
| [dsh-provider-plus](https://github.com/DPH-1121/dsh-provider-plus) | `github:DPH-1121/dsh-provider-plus` |
| [dsh-wallhaven-wallpaper](https://github.com/DPH-1121/dsh-wallhaven-wallpaper) | `github:DPH-1121/dsh-wallhaven-wallpaper` |
| [dsh-plugins](https://github.com/DPH-1121/dsh-plugins) | `github:DPH-1121/dsh-plugins` |

## 一、先选对 profile

**装错 profile 是装完「看不到」的头号原因。**

| 你在用 | profile |
|---|---|
| DeepSeek Harness 桌面版 | `desktop` |
| `dsh web` / `dsh tui` | `web` |
| headless | `headless` |

桌面版只启动 `desktop` 这一个 profile，装进 `web` 永远不会出现；反之亦然。Web 与 Headless 也是各自独立的 profile，需要分别安装。

## 二、桌面版

1. 打开 **设置 → 插件 → 添加插件**。
2. 地址填 `github:DPH-1121/<repo>`，例如 `github:DPH-1121/dsh-wallhaven-wallpaper`。
3. 安装完成后**完全退出并重新打开** Harness —— 带界面的插件只刷新页面不会生效。

## 三、命令行

```sh
# 桌面版
dsh plugin --profile desktop add github:DPH-1121/dsh-wallhaven-wallpaper

# 命令行 web / tui
dsh plugin --profile web add github:DPH-1121/dsh-provider-plus
```

安装后重启对应的 `dsh` 进程。确认装上了：

```sh
dsh --profile desktop --dump-config | tail -5
```

末尾应出现对应包名。也可以按 npm 包名或本地 `.tgz` 路径安装，把上面的 `github:...` 换成包名 / 路径即可。

## 四、装完后的第一件事

| 插件 | 下一步 |
|---|---|
| dsh-opencode-go-plus | **设置 → 模型 → OpenCode Go**，粘贴 API Key → **保存并检查**。从 `dsh-opencode-go` 迁移过来时先卸载旧包，两者不能同时安装。细节见[使用说明](https://github.com/DPH-1121/dsh-opencode-go-plus/blob/main/docs/guide.md) |
| dsh-provider-plus | **设置 → 提供商增强**：已有 provider 会自动出现，图片、请求头、模型列表、连通性、用量模板都在这里。细节见[使用说明](https://github.com/DPH-1121/dsh-provider-plus/blob/main/docs/guide.md) |
| dsh-wallhaven-wallpaper | **设置 → 壁纸**：连不上 wallhaven 时先看页面自带的代理探测。细节见[使用说明](https://github.com/DPH-1121/dsh-wallhaven-wallpaper/blob/main/docs/guide.md) |
| dsh-plugins | 左侧导航出现「插件搜集」：`/` 聚焦搜索、`Esc` 清空、复制按钮给出 `github:owner/repo`。细节见[面板说明](./面板说明.md) |

## 五、更新与卸载

在 **设置 → 插件** 里更新、停用或移除，或执行：

```sh
dsh plugin --profile desktop remove dsh-wallhaven-wallpaper
```

改完重启 Harness。

## 六、装不上时按顺序查

| 症状 | 先看这里 |
|---|---|
| 提示地址不合法 | 必须是 `github:owner/repo` 或 `https://github.com/owner/repo`，**不能指向仓库里的子目录** |
| 装完重启后功能没出现 | 先确认装的是不是当前在用的 profile；带界面的插件需要真的重启，不是刷新页面 |
| 提示「需要允许安装脚本」 | 旧版 `dsh-opencode-go-plus`（0.4.1 之前）会带 `@google/genai`、`protobufjs`；更新到 0.4.1 及以后不再需要。若是 profile 里其他插件带来的，按弹窗提示处理 |
| 安装报 `ERR_PNPM_EPERM` / rename 失败 | 多半是 `node_modules` 里残留了指向源码目录的 Junction。先卸载旧的那份，或只用 `cmd /c rmdir "<路径>"`（**不带 `/s`**）删链接，再重装 |
| 提示 peer / 版本不兼容 | 看对应仓库 README 的兼容范围或 `docs/`；确实需要放行时按启动器提示执行 `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <ver> --accept-risk` |
| 白屏 / 插件加载失败 | 看 Harness 日志里的第一条插件错误；两个同类 provider 插件会争同一个路由，先只留一个 |

还有问题：到对应仓库开 Issue。
