# 抖音

基于 **Electron** 的抖音网页端 Windows 桌面应用。程序在保留抖音网页端功能的基础上，内置了 [WhiteSevs / TamperMonkeyScript 的「抖音优化」脚本](https://scriptcat.org/zh-CN/script-show-page/2534)及其运行时兼容层。

> 仅供个人学习与使用。请遵守抖音、脚本作者及相关服务的条款；不要用本项目绕过版权、付费、访问控制或平台安全机制。

## 已集成

- `https://www.douyin.com/` 独立桌面窗口
- 登录状态、Cookie 和本地存储持久化
- 前进、后退、刷新、主页、开发者工具
- 内置抖音优化脚本及其依赖
- 尽可能兼容脚本使用的 GM 存储、请求、下载和菜单 API
- 本地「抖音优化」启用/禁用开关与完整配置界面入口
- 全中文桌面菜单、抖音应用名称与图标
- 拦截 `bytedance://` 等未安装的外部协议，避免 Windows 弹出“选择应用”窗口
- 分别清除「抖音网页数据」与「脚本配置数据」，两者互不影响
- Electron Builder Windows 安装版与便携版构建配置

## 开发

```powershell
npm install
npm run start
```

首次运行后，可在窗口顶部的 **抖音优化** 菜单中：

- 启用或停用抖音优化
- 打开桌面端配置界面
- 打开移动端配置界面

## 测试

```powershell
npm test          # 纯单元测试：URL / 协议策略
npm run test:e2e  # Electron 端到端测试（真实 preload + 真实 douyin.com 源）
npm run test:all  # 全部
```

端到端测试会：
1. 用本地 TLS 服务配合 Chromium host resolver 伪造一个真实的 `www.douyin.com` 源
   （`douyin.com` 在 HSTS 预加载列表里，必须走 HTTPS）；
2. 加载生产环境使用的 `app/preload.js` 与内置脚本；
3. 重启整个进程验证配置持久化。

> `tools/e2e/certs/` 下的自签证书不纳入版本管理，测试运行时会用 `openssl` 自动生成。
>
> 测试同时传了 `--no-proxy-server`：如果本机配置了代理，Chromium 会把请求交给代理而
> 不做本地解析，`host-resolver-rules` 就会失效，测试会**悄悄打到真实的 douyin.com**。
> 每个用例都会断言 `window.__douyinDesktopLocalStub` 来证明自己确实跑在本地桩页面上。

## 实现说明

### 脚本配置存放位置

脚本的 GM 值由**主进程**持有（`app/gm-store.js`，落盘到 `userData/userscript-config.json`），
不再放在网页的 `localStorage` 里。原因：

- 放在站点存储里时，`clearStorageData()` 会把脚本配置一起清掉，两个「清除」操作无法分开；
- 抖音页面自己也能读改清这份数据；
- 多个 iframe 各自缓存一份快照、各自整体覆盖写，会互相覆盖丢更新。

主进程持有后，preload 通过 `gm-store-read`（同步，因为 `GM_getValue` 是同步调用）一次性取回
全量数据缓存在内存里，写入走 `gm-store-set`，并由主进程广播 `gm-store-changed` 让所有框架同步。
首次运行时会把旧版存在 `localStorage` 里的配置迁移过来。

于是菜单里的两项互不影响：

| 菜单项 | 清除内容 | 保留内容 |
| --- | --- | --- |
| 清除抖音网页数据 | 登录状态、Cookie、网页缓存、网页本地数据 | 脚本配置 |
| 清除脚本配置数据 | `userscript-config.json`（脚本全部配置） | 登录状态、网页数据 |

### 为什么脚本在 `document.documentElement` 就绪后才注入

Electron 的 preload 脚本在**文档创建之前**执行，此时 `document.documentElement` 为 `null`、
`document.childNodes` 为空。内置脚本的 `DOMUtils.addStyle()` 在没有 `<head>` 时会回退到
`document.documentElement.childNodes`，于是抛出

```
TypeError: Cannot read properties of null (reading 'childNodes')
```

该异常发生在脚本顶层入口 `DouYin.init() → removeAds() → addStyle()`，会让**整个脚本中断**：
优化逻辑全部不生效，而更早注册的菜单命令仍然可用 —— 所以配置界面能正常打开、也能保存，
但设置永远不生效。

`app/dom-ready.js` 因此等待解析器插入 `<html>` 后再注入。该时机仍在页面自身脚本之前
（测试断言 `pageScriptsRanAtInject === 0`），保留 `document-start` 语义。

### 为什么用 `will-frame-navigate` 而不只是 `will-navigate`

`will-navigate` **只对主框架触发**。抖音页面大量使用 iframe，子框架里的
`bytedance://` 跳转不会被 `will-navigate` 捕获，最终交给 Windows Shell 处理，从而弹出
“需要新应用以打开此链接”。`app/url-policy.js` + `app/web-contents-guard.js` 统一收口：

| 通道 | 处理 |
| --- | --- |
| `setWindowOpenHandler` | 一律 `deny`；普通外链交给系统浏览器，字节系弹窗直接丢弃 |
| `will-frame-navigate` | 覆盖主框架与全部子框架，非 http(s)/about/blob/data 一律拦截 |
| `will-navigate` / `will-redirect` | 冗余兜底，覆盖服务端重定向 |
| `will-download` | 取消自定义协议的下载 |
| `openExternalSafely()` | 应用内唯一调用 `shell.openExternal` 的入口，非 http(s) 直接拒绝 |

## 打包 EXE

```powershell
npm run dist
```

输出位于 `dist/`：

- `抖音 Setup 0.1.0.exe`：Windows 安装包
- `抖音 0.1.0.exe`：便携式 EXE

网络受限时（国内直连 GitHub 慢或不通）先设置镜像再打包：

```powershell
$env:ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"
npm run dist
```

> 注意：`ELECTRON_BUILDER_BINARIES_MIRROR` 会改变 NSIS 工具链的缓存 key，触发重新下载。
> 如果本机已经缓存过原始来源的 NSIS 工具链，就不要再设这个变量，否则容易在
> `rename '*.tmp' -> '*'` 上撞到 Windows 的 EPERM（杀毒软件/瞬时占用）。
> 真遇到 EPERM 时，把 `dist/` 移开再重跑即可。

## 脚本来源与许可

内置脚本来自 `WhiteSevs/TamperMonkeyScript`，脚本标注为 **GPL-3.0-only**。对应脚本源码保存在：

- `assets/douyin-optimization.user.js`

其依赖的 UMD 文件保存在：

- `vendor/`

更新脚本前请阅读并遵循上游项目的许可和发布要求。
