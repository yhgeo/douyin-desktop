# AGENTS.md

给**维护者与 AI agent** 的文档。用户请读 [README.md](README.md)。

这里放的是「为什么这样写」和「怎么验证」，不是功能介绍：项目结构、约定、测试与打包、
每个恢复机制背后的实测结论，以及本机的排查手段。

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
2. 加载生产环境使用的 `app/preload/index.js` 与内置脚本；
3. 重启整个进程验证配置持久化。

> `tools/e2e/certs/` 下的自签证书不纳入版本管理，测试运行时会用 `openssl` 自动生成。
>
> 测试同时传了 `--no-proxy-server`：如果本机配置了代理，Chromium 会把请求交给代理而
> 不做本地解析，`host-resolver-rules` 就会失效，测试会**悄悄打到真实的 douyin.com**。
> 每个用例都会断言 `window.__douyinDesktopLocalStub` 来证明自己确实跑在本地桩页面上。
>
> 测试运行器会清掉 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`：前者会让 Electron 退化成
> 普通 Node，导致所有用例以难以理解的方式失败。

> **每个 e2e 窗口都要显式写 `sandbox: false`。** 不写的话 Electron 默认启用沙箱渲染进程，
> 而有些环境（CI、受限账户、代理沙箱）创建不了 Chromium 的沙箱子进程 —— 渲染进程会在加载
> 途中被杀，表现为 `ERR_FAILED` 加一个永不返回的 `executeJavaScript`，整个用例挂住、什么都不报告。
> 2026-09-21 就是这个原因：`blank-page-main.js` 漏了这一个字段，于是只有它在其它五段全绿的
> 情况下稳定失败；补上后全套 85/85，耗时从 3 分 27 秒降到 29 秒。这与 GPU 进程需要
> `--disable-gpu-sandbox` 是同一类问题（本环境无法创建 Chromium 的子进程沙箱）。

## 项目结构

代码按职责分层。`app/main.js` 只是入口，短到能当目录读；每一层的入口文件也都是一次能读完的长度。

```
app/
  main.js                    入口：只负责启动
  main/                      主进程编排
    lifecycle.js             启动顺序、单实例锁、UA、退出刷盘
    window.js                主窗口，以及挂在页面上的所有 watcher
    titles.js                修复状态对应的窗口标题（纯函数，可单测）
    menu.js                  应用菜单
    ipc.js                   与页面侧的全部 IPC 通道
    actions.js               工具菜单里的恢复动作
    userscript-config.js     脚本配置的导入导出
    userscript-menu.js       脚本自己注册的菜单项与加载状态
    broadcast.js             向所有 frame 广播
  preload/                   页面侧桥接
    index.js                 入口：判断 frame 类型后分派
    gm-api.js                GM_* API 实现
    inject.js                注入 vendor 依赖与用户脚本
  recovery/                  一类问题一个模块
    blank-page.js            服务器不给页面（黑屏）
    stuck-dialog.js          弹窗点不动
    responsiveness.js        渲染进程真卡住
  platform/                  Chromium/Electron 平台层
    script-meta.js           主进程与 preload 共用的名称（不依赖 electron）
    constants.js             路径等（主进程专用）
    dom-ready.js             等 <html> 出现再注入
    url-policy.js            哪些 URL 能交给系统
    web-contents-guard.js    跳转与弹窗策略
    external-links.js        唯一允许调 shell.openExternal 的地方
    http.js                  GM_xmlhttpRequest 的实现
  storage/                   持久化
    settings.js              应用设置
    userscript-store.js      GM 值存储实例
    gm-store.js              存储实现
    config-transfer.js       备份格式与校验
  diagnostics/               诊断
    logger.js                应用日志实例
    log-file.js              轮转文件
    page-diagnostics.js      页面事件采集与去重
```

几条约定：

- **`platform/script-meta.js` 不能 require electron。** preload 跑在渲染进程里，`app` 不存在；
  而脚本名/版本主进程和 preload 都要用，所以放在这个不依赖 electron 的模块里。
- **依赖方向单向**：`main/` 依赖 `recovery|storage|platform|diagnostics`，反向不成立。
  `userscript-menu.js` 通过注入 builder 的方式拿到 `menu.js`，避免两者成环。
- **想找某个行为在哪**：先看 `app/main.js` 的目录，再进对应模块。

## 实现说明

### 配置导入导出

菜单里的「导出配置到文件 / 从文件导入配置」由 `app/storage/config-transfer.js`（格式与校验）
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

`app/recovery/stuck-dialog.js` 的处理方式是**复用抖音自己的同步清理**：从弹窗容器的
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
| 4+ | 重复第 3 轮，间隔 15s → 60s → 180s → 300s 递增 |

真实 app + 真实抖音上实测（用 CDP 持续拒绝文档 45 秒逼它走完整阶梯）：

```
round:1  actions:["storage"]
round:2  actions:["storage","anti-crawl-cookies"]  removedCookies:["__ac_nonce","__ac_signature"]
round:3  actions:["storage","anti-crawl-cookies","http-cache"]
round:4  waitMs:10000
round:5  waitMs:30000        <- 仍在继续
```

放开拦截后页面自己回来了（112 个 body 子元素、170 个脚本、994 KB），全程无需人工干预。

#### 三种"页面打不开"，别混为一谈

2026-09-21 在用户真实 profile 的副本上逐个复现并区分开：

| 形态 | 判据 | 该做什么 |
| --- | --- | --- |
| 空文档 | `readyState: complete` + body 无子元素 + 无脚本 + `decoded: 0` | 跑阶梯（清站点数据等） |
| 反爬挑战页 | 约 101 KB、`<body></body>` + 1 段 inline 脚本（`_$jsvmprt`） | **不要动它**，它自己会算签名并跳转 |
| 验证码中间页 | `document.title === '验证码中间页'`，约 38 KB、有 body 有脚本 | 什么都别做，告诉用户"需要人机验证" |

第三种最容易误判：它有 body 有脚本，所以空文档检测器**不会**触发，窗口就那么废着、日志里也没有任何东西。
现在会识别它、写一条日志、并把窗口标题改成提示，同时**不清站点数据**（本地没坏，清也没用）。

##### 判定不能只看「有没有验证 iframe」（0.1.9 → 0.2.0）

最初把「页面里存在 `verifycenter` / `rmc-nocaptcha` 的 iframe」也算作验证码，结果是**正常页面被误报**。
日志实证（2026-09-21 14:33）：

```
服务器要求人机验证 {"href":"https://www.douyin.com/jingxuan","title":"抖音-记录美好生活"}
```

标题是正常页面，却报了验证码 —— 因为**抖音在正常页面上就预建了一个隐藏的验证 iframe**。
而误判会一直持续（页面没变），于是窗口标题上的提示永远清不掉；用户看到的就是
「没出现人机验证，但左上角一直挂着提示」。

现在判定在 `isCaptchaState(state)`（纯函数，可单测）：

| 条件 | 说明 |
| --- | --- |
| `title === '验证码中间页'` | 主要依据，最可靠 |
| `captchaFrameVisible && bodyChildren < 20` | 备选：**可见**的验证 iframe **且** 页面没有真实内容 |

探针只返回原始信号（`title` / `captchaFrameVisible` / `bodyChildren`），判定放在模块里 ——
探针是字符串、没法单测，这也是这个误判当时没能被及早发现的原因之一。

##### 状态必须「清得掉」和「设得上」一样可靠

同一个 bug 的另一半：`healthy` 只在 `rounds > 0` 时才上报，而验证码分支会把 `rounds` 归零 ——
于是「报过验证码 → 页面自己恢复」这条路径**永远清不掉提示**。
现在所有相位都走 `reportStatus()`：**按相位变化上报**（重复的 `healthy` 会被丢弃，所以正常加载
仍然不会去动窗口标题），并且验证码状态每 **3 秒**重查一次（挑战可能不经过导航就消失）。

##### watcher 的定时器要 `unref()`

验证码重查会让定时器自续，而单元测试里 watcher 从不停止 —— 结果 `npm test` **挂住 10 分钟不退出**。
两个定时器都加了 `unref()`：**watcher 的定时器不该成为进程不退出的理由**。

#### 退避为什么从 10s 改成 15s→300s

实测（同一份 profile 副本）：把 `__ac_*` 删掉强制触发挑战，脚本开与关**都会**得到空文档；
而机器**静默 5 分钟**后再启动，服务器又开始响应（这次给的是验证码中间页）。

也就是说：**服务器端有一个会因请求频率而收紧的状态**，而阶梯每 10/30/60 秒重试一次正好在
持续踩它。所以退避放长到 15s→300s，并且过了阶梯之后日志与窗口标题都改成
「服务器暂时没有返回页面，正在等待重试」—— 不是本地能修的事，就不该说成"正在自动修复"。

**给用户的建议也随之明确：不要反复重启。** 每次重启都是一次新请求，只会让服务器更不愿意响应。

#### 速度与可见性（0.1.7）

`settleMs` 从 2500 降到 700：判定条件是「文档已加载完 **且** body 无子元素 **且** 无脚本」，
所以不需要为慢渲染留时间，只要让解析器落定。三档阶梯因此从约 7.5 秒缩到 **约 2.7 秒**
（实测每轮 0.84 秒）：

```
22:03:36.820 round:1
22:03:37.655 round:2   (+0.84s)
22:03:38.491 round:3   (+0.84s)
```

同时修复过程会显示在**窗口标题**上，而不是一个毫无反馈的黑矩形：

```
抖音 — 页面加载异常，正在自动修复（第 3 次）
```

恢复后标题自动变回 `抖音`。这两点其实是同一个原因 —— **2026-09-20 21:45 的日志显示，round 1 在
21:45:37.852、round 2 在 21:45:40.366，然后就没有了：用户在第三秒把黑窗口关掉了**，而修复正在
正常往上爬。没人会等一个看起来卡死的窗口。

判定条件刻意保持严格：必须是「文档已加载完 **且** body 无子元素 **且** 无脚本」。抖音正常页面
有上百个元素，反爬挑战页也自带 inline 脚本，所以这个组合不可能是「正在加载中」；而断网时的
Chromium 错误页是有 body 内容的，所以离线不会触发这套清理。

手动入口仍然是 **工具 → 修复无法加载的页面**，它直接跑完整阶梯（不是从第 1 轮开始）。

### 运行日志

**工具 → 打开运行日志** 打开 `userData/logs/main.log`，记录：启动信息（含实际 UA）、每次导航、
加载结果、页面控制台的 warning/error、渲染进程退出，以及每一次空文档修复的轮次、动作、
删掉的 cookie 和当时的页面状态。

保留策略是**照实测定的，不是拍脑袋**：不管的话，头 75 秒就写了 22 行，其中 15 行（68%）是
同一条 CSP 警告 —— 按那个速率大约两小时就把文件轮转掉，真正有用的信息全被埋了。所以：

- 相同的控制台消息在 60 秒窗口内**折叠计数**，窗口过后再记一条并带上 `suppressedSinceLast`；
- 文件上限 2 MB，保留 2 份历史（`main.log.1` / `main.log.2`），普通使用够放好几天。

这个日志是刻意加的：前面几个问题排查时最缺的就是「出问题那一刻的现场」，只能靠推测和复现。

### 单实例锁与退出时刷盘

- **单实例锁**：同一配置目录只允许一个进程。抖音的 profile 是 Chromium 的 LevelDB，两个进程
  同时写会损坏它 —— 而「半写坏的 `Local Storage/leveldb`」正是上面那个黑屏的形态。打包版和
  `npm start` 共用配置目录，很容易不小心同时开两个。第二个实例会自动退出并把已有窗口唤到前面。
- **这个风险不是假设，是实测确认过的**：这台机器上确实同时存在**两份**这个 app ——
  `D:\.Project-FJUT\Codex\程序\抖音网页封装\` 是早期 0.1.0 的副本，`package.json` 的 `name`
  同为 `douyin-desktop`，所以**共用同一个 profile**。两个进程一起写就会留下半写状态。
  **不要同时运行那份旧副本**：它没有单实例锁（挡不住它被启动），也完全没有恢复逻辑，
  遇到黑屏只会一直黑。
- **退出时刷盘**：`before-quit` 里调用 `flushStorageData()` 与 `cookies.flushStore()`，
  减少非正常退出留下的半写状态。

### 几种运行方式的区别

| 方式 | 程序来自 | userData | 说明 |
| --- | --- | --- | --- |
| `npm start` | 仓库里的 `node_modules/electron` + 源码 | `AppData\Roaming\douyin-desktop` | 开发用，改完代码重启即生效 |
| 便携版 `抖音 x.y.z.exe` | 自解压到 `%TEMP%` 后运行 | 同上 | 绿色，不用安装 |
| 安装版（`抖音 Setup`） | 装到 `%LOCALAPPDATA%\Programs\抖音` | 同上 | 有开始菜单与桌面快捷方式 |

**三者共用同一个 profile。** `userData` 由 package.json 的 `name`（`douyin-desktop`）决定，与
构建方式无关 —— 这样登录态和脚本配置才能在它们之间延续。代价是**不能同时运行两个**：Chromium 的
profile 是 LevelDB，不支持多进程写入，两个一起写会把它写坏（上面那个黑屏就是这么来的）。

所以 0.1.5 起加了单实例锁：第二个实例立刻退出，并把已有窗口唤到最前面，日志里也会写明。启动日志还会
记录这次跑的是哪一种（`mode` / `portable` / `execPath`），不确定时看 **工具 → 打开运行日志** 的第一行。

> 单实例锁只能约束**带锁的版本**。早期构建（没有锁）仍可能与新版本同时启动，所以不要同时留着旧副本。

### 便携版会把文件解压到哪里

解压到 `%TEMP%\<名字>`，**不能**放到 exe 旁边 —— electron-builder 的 `portable` 目标就是这样实现的，
它的类型定义写得很直白：`unpackDirName` 是「the name in TEMP directory」，默认值是**每次构建都变的
ksuid**。所以 `C:\Users\<你>\AppData\Local\Temp\<随机串>\` 是它留下的，而 `D:\tmp` 不是
（那是别的程序留下的）。

想要「真正放在 exe 旁边、什么都不解压」的绿色版，用构建产物里的 **`win-unpacked/`** 目录：整个文件夹
可以放到任何位置，直接运行里面的 `抖音.exe`，不会往 `%TEMP%` 写任何东西。

### User-Agent

Electron 会把 `<productName>/<version>` 拼进 UA，而这个 app 叫「抖音」，所以它在对外宣称自己是
`... 抖音/0.1.4 Chrome/...` —— 一个网页没理由冒充的抖音 App 身份。实测在出问题的状态下，这个 UA
拿回来的是 `application/json` + 0 字节，而普通 Chrome UA 拿回来的是 HTML 页面。现在只去掉这个
token，其余保持 Chromium 原样：

```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36
```

### 启动即退出（GPU 进程无法启动）

现象：双击后窗口一闪而过。日志里是连续约 9 条然后一条 FATAL：

```
ERROR:content\browser\gpu\gpu_process_host.cc:1035] GPU process exited unexpectedly: exit_code=1
FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:417] GPU process isn't usable. Goodbye.
```

这是 Chromium 自己的行为：**GPU 子进程启动不了**时，短时间重试失败次数超限就直接中止主进程。
2026-09-20 22:13 在开发环境的工具沙箱里实测到，逐个试参数得到：

| 启动参数 | 结果 |
| --- | --- |
| 默认 | ❌ 启动约 1 秒后中止 |
| `--in-process-gpu` | ✅ 正常 |
| `--disable-gpu-sandbox` | ✅ 正常 |
| `--no-sandbox` | ✅ 正常 |
| `--disable-gpu-process-crash-limit` | ⚠️ 不再中止，但 26 秒内重试了 436 次（CPU 空转 + 日志被灌满），不可用 |

指向的是 **GPU 进程的沙箱初始化**，而不是显卡或渲染栈。

**这和应用代码无关**：同一时刻，25 分钟前还正常的打包版 0.1.6、以及开发目录（同一份源码）
都会以同样方式退出；而本项目自己的运行日志里 GPU 事件为 **0**，说明正常的启动路径不受影响。

临时绕过：

```bash
npm start -- --in-process-gpu
```

一般重启机器即可恢复。

### 脚本配置存放位置

脚本的 GM 值由**主进程**持有（`app/storage/gm-store.js`，落盘到 `userData/userscript-config.json`），
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

`app/platform/dom-ready.js` 因此等待解析器插入 `<html>` 后再注入。该时机仍在页面自身脚本之前
（测试断言 `pageScriptsRanAtInject === 0`），保留 `document-start` 语义。

### 为什么用 `will-frame-navigate` 而不只是 `will-navigate`

`will-navigate` **只对主框架触发**。抖音页面大量使用 iframe，子框架里的
`bytedance://` 跳转不会被 `will-navigate` 捕获，最终交给 Windows Shell 处理，从而弹出
“需要新应用以打开此链接”。`app/platform/url-policy.js` + `app/platform/web-contents-guard.js` 统一收口：

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

## 排查用探针

`tools/inspect/` 里有 17 个通过 CDP 连到运行中 app 的探针（页面状态、网络响应、会话存储、
弹窗形态、播放器指标、环境对照）。它们**不是测试** —— 单元测试在 `test/`，端到端在 `tools/e2e/`。

用途与选择方法见 `tools/inspect/README.md`。

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
