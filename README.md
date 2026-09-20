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
- 脚本配置支持导出到文件 / 从文件导入，便于备份与恢复
- Electron Builder Windows 安装版与便携版构建配置

## 开发

```powershell
npm install
npm run start
```

首次运行后，可在窗口顶部的 **抖音优化** 菜单中：

- 启用或停用抖音优化
- 打开配置界面 / 打开移动端配置
- 导出配置到文件 / 从文件导入配置

脚本自身的设置面板保持原样，未做任何改动。

## 测试

```powershell
npm test          # 纯单元测试：URL / 协议策略、配置导入导出与备份恢复
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
>
> 测试运行器会清掉 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`：前者会让 Electron 退化成
> 普通 Node，导致所有用例以难以理解的方式失败。

## 实现说明

### 配置导入导出

菜单里的「导出配置到文件 / 从文件导入配置」由 `app/config-transfer.js`（格式与校验）
配合主进程的系统文件对话框完成：

```json
{
  "app": "douyin-desktop",
  "format": 1,
  "exportedAt": "2026-09-20T01:00:00.000Z",
  "script": { "name": "抖音优化", "version": "2026.9.17.17" },
  "values": { "GM_Panel": {}, "short-cut": [] }
}
```

导入时同时接受这种包装格式和**裸的 `{ key: value }`**——后者正是脚本自身
「导出至文件」产出的格式，因此桌面端与 Tampermonkey 的备份可以互相通用。
导入会先确认再整体覆盖，并校验文件非空、是 JSON 对象、体积不超过 8 MB。

### 卡住的弹窗会自动关闭

抖音自己的「是否保存登录信息？」弹窗有条**卡死路径**，值得记一笔：

- **倒计时路径**是同步的：`defaultHandler` 直接调用清理函数，所以不点它总会自己消失。
- **点击路径**不是：`confirmHandler` 里是
  `someAsyncCall().then(() => h()).catch(() => h())`，而**只有 `h()` 里的清理会移除弹窗**。
  那个异步调用一旦不 settle，弹窗就永远留着。
- 点击还会 `clearTimeout()` **把倒计时取消掉**，所以点过之后弹窗再也没有自救的办法。
- 此时按钮已经进入 Semi 的 loading 态（`pointer-events: none`），整个遮罩罩住页面，
  用户除了刷新别无他法。

`app/stuck-dialog-recovery.js` 的处理方式是**复用抖音自己的同步清理**：从弹窗容器的
`__reactContainer$xxx` 沿 React fiber 树找到组件的 `defaultHandler` prop 并调用它 ——
也就是倒计时按钮走的那条路径。只有找不到该 prop 时才兜底移除容器节点。

触发方式两种：

| 方式 | 时机 |
| --- | --- |
| 工具 → 关闭卡住的弹窗 | 立即，无需等待 |
| 页面内 watcher | 检测到「弹窗还在 + 至少一个按钮不可用」后**立即恢复**（实测 0.7–1.1 秒） |

> 为什么是「至少一个」而不是「全部」：只点「保存」时「取消」仍可点，要求全部不可用会
> 完全检测不到 —— 这正是最初漏掉的情况。而「有按钮在 loading」就等价于「点过了、
> 关闭路径正在等那个调用」，因为点击同时取消了倒计时。

> 为什么可以「立即」而不用等：早先版本是 2 秒轮询 + 6 秒宽限，也就是最长 8 秒才有动作，
> 用户读到的是「程序坏了」而不是「程序在帮忙」。等待本身没有收益 —— 点击发起的请求是
> fire-and-forget，关掉弹窗**不会取消它**；而抖音自己的倒计时路径也是**同步**关掉弹窗、
> 不等任何请求。唯一的让步是状态需要连续两次轮询都成立（默认 400ms 轮询，代价 400ms），
> 以免把单帧重渲染误判成卡死。

「按钮不可用」的判定涵盖多种信号：`pointer-events: none`、`disabled`、`aria-disabled="true"`、
`semi-button-loading` 类、以及**只带一个 spinner 子元素**的情况 —— 每种都可能是某个版本里
唯一的线索，而漏判是**静默**的（什么都不发生、也不打日志）。另外按钮的类名被改过，
所以精确选择器找不到时会退回 `[class*="trust-login-dialog-button"]`（并过滤掉容器 div）。

弹窗存在但一直没被判定为卡住、且已超过 9 秒（远超任何正常倒计时）时会打一条诊断日志
`[抖音] 弹窗一直未被判定为卡住：{...}`，把按钮的形态写进去 —— 这样下一次漏判是**可查的**，
不用再靠猜。

### 打开黑屏（抖音不返回页面）会自动修复

2026-09-20 遇到过一种黑屏：窗口打开后一片黑，**刷新没用、重启也没用**。

排查过程与结论（都是实测，不是推断）：

1. 页面里 `body` 是空的、`<script>` 数为 0，但**用户脚本注入的样式还在** —— 说明脚本层在跑，是文档本身没内容。
2. `performance.getEntriesByType('navigation')[0]` 给出 `responseStatus: 200`、`decodedBodySize: 0` —— **服务器返回了空响应体**。
3. 拿**同一个 app、换一个全新 profile** → 页面完整加载（1.6 MB、193 个脚本）。**所以不是 app 的代码或配置问题。**
4. 服务器偶尔返回的是字节的**反爬挑战页**（`_$jsvmprt`：`<body></body>` + 一段混淆脚本），
   它要算出 `__ac_signature` 再跳转；但在出问题的 profile 上这段脚本**永远算不对**。
5. 对比两个 profile，找到差异：出问题的 profile 里
   **`localStorage` 只剩 2 个 key（正常约 54 个）**，`Local Storage/leveldb` 目录里还残留 `.tmp` 文件
   —— 进程被强杀留下的痕迹。反爬挑战依赖这份状态，状态残缺 → 签名不匹配 → 服务器拒绝后续导航
   → 挑战再也没机会重跑。**死锁，刷新救不了。**

修复：清掉站点**非 cookie** 的持久化数据，让挑战从零重跑：

```
serviceworkers, cachestorage, localstorage, indexdb
```

**cookie 故意不动** —— 清 cookie 会掉登录，而且实验证明 cookie 不是原因（把出问题 profile 的
55 个 cookie 注入全新 profile，页面照常加载）。实测在你出问题的 profile 上，页面立刻恢复、
**登录态保留**，连刷两次都正常。

#### 只修一次不够：现在是阶梯式升级，永不放弃（0.1.5）

上面那版**修两次就永久放弃**，而且只在「真实页面加载成功」时才重置次数。所以两次都没修好，
窗口就会一直黑到重启为止 —— 而且**全程没有任何日志**。这才是「过几个小时又黑屏、只能手动修」
的真正原因：不是没修，是修完就停了。

现在的行为是阶梯式升级：

| 轮次 | 动作 |
| --- | --- |
| 1 | 清站点非 cookie 存储 |
| 2 | 再加：删掉 `__ac_signature` / `__ac_nonce` / `__ac_referer`（**只删反爬 cookie，登录 cookie 一个不碰**） |
| 3 | 再加：清 HTTP 缓存 |
| 4+ | 重复第 3 轮，间隔 10s → 30s → 60s → 120s 递增 |

真实 app + 真实抖音上实测（用 CDP 持续拒绝文档 45 秒逼它走完整阶梯）：

```
round:1  actions:["storage"]
round:2  actions:["storage","anti-crawl-cookies"]  removedCookies:["__ac_nonce","__ac_signature"]
round:3  actions:["storage","anti-crawl-cookies","http-cache"]
round:4  waitMs:10000
round:5  waitMs:30000        <- 仍在继续
```

放开拦截后页面自己回来了（112 个 body 子元素、170 个脚本、994 KB），全程无需人工干预。

判定条件刻意保持严格：必须是「文档已加载完 **且** body 无子元素 **且** 无脚本」。抖音正常页面
有上百个元素，反爬挑战页也自带 inline 脚本，所以这个组合不可能是「正在加载中」；而断网时的
Chromium 错误页是有 body 内容的，所以离线不会触发这套清理。

手动入口仍然是 **工具 → 修复无法加载的页面**，它直接跑完整阶梯（不是从第 1 轮开始）。

### 运行日志

**工具 → 打开运行日志** 打开 `userData/logs/main.log`，记录：启动信息（含实际 UA）、每次导航、
加载结果、页面控制台的 warning/error、渲染进程退出，以及每一次空文档修复的轮次、动作、
删掉的 cookie 和当时的页面状态。超过 512 KB 自动轮转，只留上一份。

这个日志是刻意加的：前面几个问题排查时最缺的就是「出问题那一刻的现场」，只能靠推测和复现。

### 单实例锁与退出时刷盘

- **单实例锁**：同一配置目录只允许一个进程。抖音的 profile 是 Chromium 的 LevelDB，两个进程
  同时写会损坏它 —— 而「半写坏的 `Local Storage/leveldb`」正是上面那个黑屏的形态。打包版和
  `npm start` 共用配置目录，很容易不小心同时开两个。第二个实例会自动退出并把已有窗口唤到前面。
- **退出时刷盘**：`before-quit` 里调用 `flushStorageData()` 与 `cookies.flushStore()`，
  减少非正常退出留下的半写状态。

### User-Agent

Electron 会把 `<productName>/<version>` 拼进 UA，而这个 app 叫「抖音」，所以它在对外宣称自己是
`... 抖音/0.1.4 Chrome/...` —— 一个网页没理由冒充的抖音 App 身份。实测在出问题的状态下，这个 UA
拿回来的是 `application/json` + 0 字节，而普通 Chrome UA 拿回来的是 HTML 页面。现在只去掉这个
token，其余保持 Chromium 原样：

```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36
```

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
| `setWindowOpenHandler` | 抖音自身域名的弹窗**放行**（它的登录/验证/分享弹窗依赖这些窗口，拦掉会让弹窗遮罩卡死页面）；普通外链交给系统浏览器；字节系第三方与自定义协议直接丢弃 |
| `will-frame-navigate` | 覆盖主框架与全部子框架，非 http(s)/about/blob/data 一律拦截 |
| `will-navigate` / `will-redirect` | 冗余兜底，覆盖服务端重定向 |
| `will-download` | 取消自定义协议的下载 |
| `openExternalSafely()` | 应用内唯一调用 `shell.openExternal` 的入口，非 http(s) 直接拒绝 |

> 注意这里的分寸：**拦截的是自定义协议**（`bytedance://` 等交给 Windows Shell 才会弹系统提示），
> 而不是抖音自己的网页弹窗。把 `*.douyin.com` 的 `window.open` 也一并拦掉，会让抖音的弹窗
> 拿不到新窗口、遮罩无法关闭，表现为「选完就卡住，只能刷新」。

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
