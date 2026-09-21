# AGENTS.md

给**维护者与 AI agent** 的文档。终端用户请看 [README.md](README.md)。

这份文档只回答两件事：**为什么这样写**（设计决策与不变量）和**怎么验证**（测试、打包、排查手段）。
功能怎么用不在这里 —— 那在 README。

## 目录

| 章节 | 内容 |
| --- | --- |
| [快速开始](#快速开始) | 安装、运行、测试、打包 |
| [项目结构](#项目结构) | 模块划分与依赖方向 |
| [不变量](#不变量) | 改代码前必须先读的硬约束 |
| [设计决策](#设计决策) | 为什么这样实现 |
| [恢复机制](#恢复机制) | 三类"页面坏了"的处理方式 |
| [测试](#测试) | 单元与端到端 |
| [打包与发布](#打包与发布) | 构建、清理、发布 |
| [排查手册](#排查手册) | 症状 → 手段 |

## 快速开始

```console
npm install
npm start               # 开发运行；改动源码后重启生效
npm test                # 单元测试
npm run test:e2e        # 端到端测试（自带桩服务器，不需要外网）
npm run dist            # 打包便携版到 dist/
npm run dist:installer  # 打包安装版（NSIS）到 dist/
```

窗口顶部 **抖音优化** 菜单可启用 / 停用脚本、打开配置界面（`Ctrl+,`）、导出 / 导入配置。

> **便携版每次启动要自解压，约多花 12 秒**；安装版没有这个开销。数字与原因见
> 「[启动耗时](#启动耗时日志从哪一刻开始算)」。两者共用同一份 profile，换用不会掉登录。

## 项目结构

`app/main.js` 只是入口，短到能当目录读；每层入口文件也都是一次能读完的长度。

```
app/
  main.js                    入口：只负责启动
  main/                      主进程编排
    lifecycle.js             启动顺序、单实例锁、UA、下载策略挂载、退出刷盘
    window.js                主窗口，以及挂在页面上的所有 watcher
    titles.js                修复状态对应的窗口标题（纯函数，可单测）
    title-state.js           每个窗口当前的修复状态；两个标题写入方共用同一份
    menu.js                  应用菜单
    ipc.js                   与页面侧的全部 IPC 通道
    actions.js               工具菜单里的恢复动作
    userscript-config.js     脚本配置的导入导出
    userscript-menu.js       脚本自己注册的菜单项与加载状态
    broadcast.js             向所有 frame 广播
  preload/                   页面侧桥接
    index.js                 入口：判断 frame 与站点后分派（实际只在顶层 frame 运行）
    gm-api.js                GM_* API 实现
    inject.js                注入 vendor 依赖与用户脚本
  recovery/                  一类问题一个模块
    blank-page.js            服务器不给页面（黑屏）
    stuck-dialog.js          弹窗点不动
    responsiveness.js        渲染进程真卡住
  platform/                  Chromium / Electron 平台层
    script-meta.js           主进程与 preload 共用的名称（不依赖 electron）
    constants.js             路径等（主进程专用）
    loading-document.js      加载页（不依赖 electron，可单测）
    dom-ready.js             等 <html> 出现再注入
    url-policy.js            哪些 URL 能交给系统
    web-contents-guard.js    跳转与弹窗策略（挂在 webContents 上）
    downloads.js             下载策略与 GM_download（挂在 session 上）
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
test/                        单元测试（node --test，不需要 Electron）
  helpers/electron-stub.js   替身夹具；唯一需要它的测试见「测试」
tools/
  build/                     构建辅助：清理 dist 与历史构建目录
  e2e/                       端到端测试与桩服务器
  inspect/                   连到运行中 app 的排查探针（索引见 tools/inspect/README.md）
```

依赖方向单向：`main/` 依赖 `recovery|storage|platform|diagnostics`，反向不成立。
`userscript-menu.js` 通过注入 builder 拿到 `menu.js`，避免两者成环。

**想找某个行为在哪**：先看 `app/main.js` 的目录，再进对应模块。

## 不变量

改代码前先确认不破坏这几条。每一条都是踩过坑之后立的，删掉之前先读理由。

| 不变量 | 为什么 |
| --- | --- |
| `platform/script-meta.js` 不得 `require('electron')` | preload 跑在渲染进程里，没有 `app`；而脚本名与版本两边都要用 |
| 清理站点存储时**永不含 `cookies`** | 清 cookie 会掉登录；且实测证明 cookie 不是黑屏的原因（把出问题的 55 个 cookie 注入全新 profile，页面照常加载） |
| 每个 e2e 窗口显式写 `sandbox: false` | 不写会默认启用沙箱渲染进程；在创建不了 Chromium 子进程沙箱的环境里，渲染进程会在加载途中被杀 —— `ERR_FAILED` 加一个永不返回的 `executeJavaScript`，用例挂住且什么都不报告 |
| watcher 的定时器必须 `unref()` | 会自续的定时器（如验证码重查）会让进程永不退出 —— 单元测试里没人调 `stop()` |
| 但"为答复调用方而存在"的定时器**不得** `unref()` | 与上一条相反。`unref` 之后事件循环会在调用方仍在等待时退出（实测让 10 个用例被判为 `cancelled`）。它要在结算时 `clearTimeout`，而不是 unref —— 它存在的意义就是把事件循环**留住**到给出答复 |
| 每个跨进程调用都要设时限 | `cookies.*`、`clearStorageData`、`clearCache` 都由 Chromium 的**网络服务**执行；该服务崩溃时 promise 永不 settle，修复会卡在半路 —— 比失败更糟 |
| `will-download` 只能挂在 `session` 上 | 它是 **Session** 事件，不是 WebContents 事件。挂在 `webContents` 上不报错、只是永不触发 —— 自定义协议下载防护曾因此完全失效（见「下载策略」） |
| 持有 GM 值的对象必须是 null 原型 | 普通对象字面量上 `obj['__proto__'] = v` 走的是继承来的 setter，会**换掉原型**而不是加一个键：值读得到、`has()` 说没有、也不会落盘 |
| 从渲染进程来的载荷先校验形状 | 页面与 preload 共享同一作用域（`contextIsolation: false`），IPC 参数不是可信输入；GM 值还可能是用户手改或从 Tampermonkey 导入的 |
| 加载页必须是 `data:`，且带 body 子元素 | 两个方向都会静默出事：`file:` 会被 `web-contents-guard.js` 的导航白名单拦掉（用户又看到黑窗）；而没有 body 子元素会被空文档判定命中，**每次启动清掉用户的站点数据**。两条都由 `test/loading-document.test.js` 钉住 |
| 判定页面状态不能只看"元素是否存在" | 站点会预建隐藏元素：抖音在**正常页面**上就有一个隐藏的验证 iframe |
| 状态必须"清得掉"和"设得上"一样可靠 | 否则提示会永久留在窗口标题上（曾经如此） |
| 注入等 `<html>` 出现，而不是等 `DOMContentLoaded` | 早于 `<html>` 注入会让脚本抛错并**整体中断**（见「注入时机」） |
| 单元测试的 teardown 失败不得判测试失败 | 清理与断言是两件事；沙箱的删除垫片会让"断言全过"的测试随机失败 |


## 设计决策

### 脚本配置由主进程持有

脚本的 GM 值落盘在 `userData/userscript-config.json`（`app/storage/gm-store.js`），**不放网页的 `localStorage`**。
放在站点存储里有三个问题：`clearStorageData()` 会把脚本配置一起清掉（两个「清除」分不开）；
抖音页面自己能读改清；以及快照式整体覆盖写会丢更新 —— 每个持有副本的执行环境都读一次全量、改一处、
整体写回，两处并发就互相抹掉。

最后一条今天还不会发生（preload 只在顶层 frame 运行，只有一个副本），但它是这套存储**不能**留在页面的
结构性原因：Tampermonkey 下的同一份脚本会注入到每个匹配的 iframe，而桌面端只要哪天打开
`nodeIntegrationInSubFrames` 也会变成多副本。真源只有主进程里那一份。

preload 通过同步的 `gm-store-read` 一次取回全量数据缓存在内存（`GM_getValue` 是同步调用），
写入走 `gm-store-set`，主进程再广播 `gm-store-changed` 让持有副本的 frame 同步。
首次运行会把旧版留在 `localStorage` 里的配置迁移过来。

于是两项清除互不影响：

| 菜单项 | 清除 | 保留 |
| --- | --- | --- |
| 清除抖音网页数据 | 登录状态、Cookie、网页缓存与本地数据 | 脚本配置 |
| 清除脚本配置数据 | `userscript-config.json` | 登录状态、网页数据 |

脚本配置的导入导出由 `app/storage/config-transfer.js` 负责。导入同时接受包装格式和**裸的
`{ key: value }`** —— 后者正是脚本自身「导出至文件」的格式，所以桌面端与 Tampermonkey 的备份可以互相通用。
导入会先确认再整体覆盖，并校验非空、是 JSON 对象、体积不超过 8 MB。

包装格式靠 `app` 标记**加上 `format` 字段**共同识别。只看 `app` + `values` 会把一份恰好用了这两个
键名的裸配置读成包装格式：实测三键进、一键出 —— `values` 被当成载荷，其余设置被静默丢掉。
带标记但没有 `format` 的文件现在**明确报错**而不是猜，因为猜错的代价是用户的配置。

### 注入时机：等 `<html>`，不等 `DOMContentLoaded`

Electron 的 preload 在**文档创建之前**执行，那时 `document.documentElement` 是 `null`。
内置脚本的 `DOMUtils.addStyle()` 在没有 `<head>` 时会回退到 `document.documentElement.childNodes`，
于是抛 `TypeError: Cannot read properties of null (reading 'childNodes')`。

该异常发生在脚本顶层入口（`DouYin.init() → removeAds() → addStyle()`），会让**整个脚本中断**：
优化逻辑全部不生效，而更早注册的菜单命令仍然可用 —— 表现为"配置界面能打开也能保存，但设置永远不生效"。

`app/platform/dom-ready.js` 因此等解析器插入 `<html>` 后再注入。该时机仍在页面自身脚本之前
（测试断言 `pageScriptsRanAtInject === 0`），保留 `document-start` 语义。

### `contextIsolation: false` 的取舍

窗口用 `contextIsolation: false` + `nodeIntegration: false` + `sandbox: false`。这不是随手写的默认值，
是这套方案的前提：

- 内置脚本是 Tampermonkey 脚本，**必须**跑在页面自己的全局作用域里才能改页面 —— `inject.js` 依赖
  这一点（用的是间接 `eval`）。
- `contextIsolation: true` 会把 preload 关进隔离世界，脚本就改不到页面；`sandbox: true` 则不让
  preload 用 `node:fs` 读内置脚本与 `vendor/` 里的依赖。

代价要说清楚：preload 与页面**共享同一个 `window`**，所以页面能摸到 GM_* 的实现。
兜底不是"信任页面"，而是把应用侧的能力面收窄：

| 措施 | 收窄了什么 |
| --- | --- |
| `nodeIntegration: false` | 页面拿不到 `require`，只能用 preload 显式暴露的那几个函数 |
| GM_* 是一份固定的 API 面 | 没有"任意通道"可用；新增能力必须显式写进 `gm-api.js` |
| 每个 IPC 载荷都校验形状 | 页面传进来的不是可信输入（见「不变量」） |
| 对外打开只走 `openExternalSafely()` | 页面无法让应用去执行本地程序或自定义协议 |

> 分寸是"信任抖音的页面，但不假设它永远不作恶"：站点本来就能读写自己的存储与网络，真正的边界在
> **应用侧的能力**，那部分必须显式收口。

### 跳转与弹窗策略

`will-navigate` **只对主框架触发**，而抖音大量使用 iframe —— 子框架里的 `bytedance://` 跳转
不会被它捕获，最终交给 Windows Shell，弹出"需要新应用以打开此链接"。
`app/platform/url-policy.js` 与 `web-contents-guard.js` 统一收口：

| 通道 | 处理 |
| --- | --- |
| `setWindowOpenHandler` | 抖音自身域名的弹窗**放行**（登录 / 验证 / 分享依赖这些窗口）；普通外链交给系统浏览器；字节系第三方与自定义协议丢弃 |
| `will-frame-navigate` | 覆盖主框架与全部子框架，非 http(s)/about/blob/data 一律拦截 |
| `will-navigate` / `will-redirect` | 冗余兜底，覆盖服务端重定向 |
| `openExternalSafely()` | 应用内唯一调用 `shell.openExternal` 的入口，非 http(s) 直接拒绝 |

> 分寸在这里：**拦的是自定义协议**，不是抖音自己的网页弹窗。把 `*.douyin.com` 的 `window.open`
> 也拦掉，抖音的弹窗就拿不到新窗口、遮罩无法关闭，表现为"选完就卡住，只能刷新"。

### 下载策略：`will-download` 是 Session 事件

上面那张表的通道都挂在 `webContents` 上，下载不在其中 —— `will-download` 属于 **`session`**。

这个区别不会报错，只会让处理器**永不触发**。早先的写法是 `contents.on('will-download', ...)`，
用来丢弃自定义协议的下载；实测同时挂两处、触发两次下载，结果是 `webContents` 上 **0 次**、
`session` 上 **2 次** —— 那段防护一直是死代码，`bytedance://` 之类的下载仍会走到 Windows Shell，
正是本应用要消灭的"需要新应用以打开此链接"。

`app/platform/downloads.js` 因此挂在 session 上，同时负责两件事：

| 职责 | 说明 |
| --- | --- |
| 拒绝非 http(s) 下载 | 自定义协议一律 `preventDefault()`，不留任何交给系统的路径 |
| 支撑 `GM_download` | 用脚本指定的文件名保存，并把进度 / 完成 / 取消回传给发起方 |

第二件事不是可选项：脚本的下载 UI 完全建立在这些回调上（进度百分比、失败提示、关闭 toast 时取消）。
原先的实现是**立即调 `onload()`**，于是在传输开始之前就告诉用户"下载已完成"。

> 队列按 URL 分桶，不是全局 FIFO：`downloadURL()` 是异步兑现的，全局队列会在两个下载重叠时
> 把名字配错文件。落盘前还会过一次文件名清洗与去重 —— `setSavePath()` 是**静默覆盖**的。

### 单实例锁与 profile

`userData` 由 `package.json` 的 `name`（`douyin-desktop`）决定，**与构建方式无关** —— 所以开发运行、
便携版、安装版共用同一份 profile，登录态与脚本配置才能在它们之间延续。

代价是**不能同时运行两个**：Chromium 的 profile 是 LevelDB，不支持多进程写入，两个一起写会留下
半写坏的状态 —— 而"半写坏的 `Local Storage/leveldb`"正是黑屏的形态。

所以有单实例锁：第二个实例立刻退出，把已有窗口唤到最前，日志里写明。启动日志会记录这次是哪种运行方式
（`mode` / `portable` / `execPath`），不确定时看 **工具 → 打开运行日志** 的第一行。

> 单实例锁只能约束**带锁的版本**。更早的构建（没有锁）仍可能与新版本同时启动 ——
> 机器上如果还留着旧副本，不要运行它。

退出时 `before-quit` 会调 `flushStorageData()` 与 `cookies.flushStore()`，减少非正常退出留下的半写状态。

### User-Agent

Electron 会把 `<productName>/<version>` 拼进 UA，而本应用叫"抖音"，于是它对外宣称自己是
`... 抖音/<version> Chrome/...` —— 一个网页没理由冒充的抖音 App 身份。实测在出问题的状态下，
这个 UA 拿到的是 `application/json` + 0 字节，而普通 Chrome UA 拿到的是 HTML。
现在只去掉这个 token，其余保持 Chromium 原样。

### 运行日志

**工具 → 打开运行日志** 打开 `userData/logs/main.log`：启动信息（含实际 UA）、每次导航与结果、
页面控制台的 warning/error、渲染进程退出，以及每次空文档修复的轮次、动作、删掉的 cookie 与当时的页面状态。

保留策略是照实测定的，不是拍脑袋：不管的话头 75 秒就写 22 行，其中 15 行（68%）是同一条 CSP 警告，
按那个速率约两小时就把文件轮转掉，有用信息全被埋了。所以相同的控制台消息在 60 秒窗口内**折叠计数**
（窗口过后再记一条并带 `suppressedSinceLast`），文件上限 2 MB、保留 2 份历史。

这个日志是刻意加的：前面几次排查最缺的就是"出问题那一刻的现场"。

### 启动耗时：日志从哪一刻开始算

有人报「打开要十几秒」时，第一个问题是**这十几秒在谁那里**。实测（外部计时，因为 app 自己看不见
最早那一段）：

| 阶段 | 便携版 | 安装版 / `win-unpacked` |
| --- | --- | --- |
| 进程创建 → app 就绪 | **15742 ms** | **2986 ms** |
| app 就绪 → 窗口出现 | 142 ms | 232 ms |
| 窗口出现 → 页面加载完 | 4669 ms | 10161 ms（网络波动很大） |

**便携版多出来的约 12.7 秒全在自解压上。** 它是 NSIS 自解压包：每次启动把整个应用（约 470 MB）
从 100 MB 的压缩包里解到 `%TEMP%\<随机目录>`，从那里运行，退出时删掉。读
`app-builder-lib/templates/nsis/portable.nsi` 确认过：`RMDir /r $INSTDIR` 之后紧接 `File /r`，
**无条件重新解压** —— 所以把 `portable.unpackDirName` 改成固定名字也**不会**带来复用，
它只改变解压到哪里。这是这个格式的固有代价，不是配置没调对。

安装版（`npm run dist:installer`）把文件放到固定位置，启动时直接读，省掉这 12.7 秒。
两者共用同一份 profile（`userData` 由 package.json 的 `name` 决定），换过去不掉登录、不丢脚本配置。

日志里的时间线只能从**本进程的模块加载**开始算（`process.uptime()`，实测模块加载 78 ms、
`whenReady` 187 ms），所以它**看不见**自解压那一段 —— 那段发生在进程存在之前。启动那行因此记
`timing.moduleLoadMs` / `timing.appReadyMs`，窗口起来后再记一行：

```
启动     {"timing":{"moduleLoadMs":…,"appReadyMs":…},"mode":"packaged","portable":true,…}
窗口就绪  {"totalMs":…,"windowMs":…}
```

`portable: true` 是关键字段：看到它，就知道这些数字**不包含**那 12.7 秒。否则一次慢启动看起来
就像代码慢。

### 加载页：黑窗不能拿来当加载状态

窗口在页面取回来之前就创建了，而它的背景色是近黑 —— 恰好也是这个应用在**服务器不给页面**时的样子。
于是「正常加载中」和「本应用有一整套恢复机制的那个故障」长得一模一样，而恢复机制的提示在标题栏，
盯着黑矩形的人不会去看。

`platform/loading-document.js` 因此提供一个本地文档：logo + 「正在加载…」。两个约束都不是审美问题：

- **必须是 `data:`**。`web-contents-guard.js` 只放行 http(s)/about/blob/data/filesystem/chrome/devtools，
  所以 `loadFile()` 会被**本应用自己的策略**拦掉。logo 内联成 data URI，文档因此完全自足 ——
  `data:` 是不透明源，取不到任何外部文件。
- **必须带 body 子元素**。空文档判定要求「无 body 子元素 **且** 无脚本」，所以一个纯文字的加载页
  会被判成空文档 —— 每次启动清一遍用户的站点数据。实测 `bodyChildren: 2`，安全。

它被刻意抽成不依赖 `electron` 的模块：`platform/constants.js` 在加载期调 `app.getPath`，引用它的
模块根本无法单测，而这两条约束正是最需要被钉住的。诊断那边也配合了一处：`page-diagnostics.js`
只记录 http(s) 导航，否则这个几 KB 的 `data:` URL 会每次启动往日志里灌两遍。

代价也量过，不是感觉（同机 dev A/B）：加载页让「app 就绪 → 真正开始导航」从 146 ms 变成 391 ms，
**净成本约 245 ms**；换来的是打包版里约 1.8 秒的黑窗变成可见反馈。这笔交易不接近，但前提是知道
那 245 ms 是多少 —— 所以下次有人想「优化掉」这个加载页，先看这一行。

## 恢复机制

三类"页面坏了"，处理方式不同，**不要混为一谈**：

| 形态 | 判据 | 处理 |
| --- | --- | --- |
| 空文档 | `readyState: complete` + body 无子元素 + 无脚本 | 跑阶梯（清站点数据等） |
| 反爬挑战页 | 约 101 KB、`<body></body>` + 1 段混淆脚本（`_$jsvmprt`） | **不要动它**，它自己会算签名并跳转 |
| 验证码中间页 | `title === '验证码中间页'`，约 38 KB、有 body 有脚本 | 什么都不做，只提示用户 |

判据里的三项是**与**关系，并且刻意**不含** `decoded`（已解码字节数）。探针仍会把它带回来写进日志，
因为它对排查有用 —— 但它不进判定：Chromium 会把非空的 `text/plain` 与 JSON 响应包进元素里，
"有没有内容"这件事 `bodyChildren` 已经覆盖；而把 `decoded === 0` 也要求上，反而会**漏掉真正该修的那种**：
一个约 40 字节、有 `<html>` 却没有任何内容的空壳，它的 `decoded` 并不是 0。

第三种最容易误判：它有 body 有脚本，所以空文档检测器**不会**触发，窗口就那么废着、日志里也没有任何东西。

判定在 `isCaptchaState(state)`（纯函数，可单测）：

| 条件 | 说明 |
| --- | --- |
| `title === '验证码中间页'` | 主要依据 |
| `captchaFrameVisible && bodyChildren < 20` | 备选：**可见**的验证 iframe **且** 页面没有真实内容 |

探针只返回原始信号（`title` / `captchaFrameVisible` / `bodyChildren`），判定放在模块里 ——
探针是字符串、没法单测。**只凭"存在验证 iframe"判定会误报**：抖音在正常页面上就预建了一个隐藏的。

### 服务器不给页面（黑屏）

现象：窗口一片黑，**刷新没用、重启也没用** —— 因为病因是**持久化的站点状态**，不在内存里。

原因：抖音的反爬挑战（`_$jsvmprt`）靠网页存储算 `__ac_signature`。当 `localStorage` 被写坏
（实测只剩 2 个 key，正常约 54 个，`leveldb` 里还留着 `.tmp` 残留），签名永远算不对，
服务器拒绝后续导航，挑战再也没机会重跑 —— **死锁**。

`app/recovery/blank-page.js` 清掉站点**非 cookie** 存储
（`serviceworkers, cachestorage, localstorage, indexdb`），让挑战从零重跑，**登录态保留**。

阶梯式升级、永不放弃（早期版本修两次就永久放弃，而且不留任何日志 —— 那才是"过几小时又黑、只能重启"的真因）：

| 轮次 | 动作 |
| --- | --- |
| 1 | 清站点非 cookie 存储 |
| 2 | 再加：删 `__ac_signature` / `__ac_nonce` / `__ac_referer`（**只删反爬 cookie，登录 cookie 一个不碰**） |
| 3 | 再加：清 HTTP 缓存 |
| 4+ | 重复第 3 轮，间隔 15s → 60s → 180s → 300s |

退避之所以这么长：服务器端有一个**会因请求频率而收紧**的状态 —— 删掉 `__ac_*` 强制触发挑战时，
脚本开与关**都会**得到空文档；而机器静默 5 分钟后服务器又开始响应。所以过了阶梯之后，日志与窗口标题
改成「服务器暂时没有返回页面，正在等待重试」—— 不是本地能修的事，就不该说成"正在自动修复"。
**给用户的建议也随之明确：不要反复重启。**

判定条件刻意保持严格（文档已加载完 **且** body 无子元素 **且** 无脚本）：抖音正常页面有上百个元素，
反爬挑战页自带 inline 脚本，所以这个组合不可能是"正在加载中"；而断网时 Chromium 的错误页有 body 内容，
所以**离线不会触发**这套清理。

`settleMs = 700`：判定条件已保证文档加载完了，不需要为慢渲染留时间，只要解析器落定 ——
三档阶梯因此约 2.7 秒走完（每轮约 0.84 秒）。修复过程会显示在**窗口标题**上
（`抖音 — 页面加载异常，正在自动修复（第 3 次）`，恢复后变回 `抖音`）：**没人会等一个看起来卡死的窗口**。

手动入口：**工具 → 修复无法加载的页面**（直接跑完整阶梯，不是从第 1 轮开始）。

### 弹窗点不动

抖音的「是否保存登录信息？」有条卡死路径：

- **倒计时路径是同步的**：`defaultHandler` 直接调用清理函数，所以不点它总会自己消失。
- **点击路径不是**：`confirmHandler` 里是 `someAsyncCall().then(() => h()).catch(() => h())`，
  而**只有 `h()` 里的清理会移除弹窗**。那个调用一旦不 settle，弹窗就永远留着。
- 点击还会 `clearTimeout()` **取消倒计时**，所以点过之后弹窗再无自救办法。
- 此时按钮已进入 Semi 的 loading 态（`pointer-events: none`），遮罩罩住整页。

`app/recovery/stuck-dialog.js` 的解法是**复用抖音自己的同步清理**：从弹窗容器的
React 容器属性沿 fiber 树找到组件的 `defaultHandler` prop 并调用它 ——
也就是倒计时按钮走的那条路径。找不到该 prop 时才兜底移除容器节点。

| 触发方式 | 时机 |
| --- | --- |
| 工具 → 关闭卡住的弹窗 | 立即 |
| 页面内 watcher | 检测到"弹窗还在 + 至少一个按钮不可用"后立即恢复（实测 0.7–1.1 秒） |

> **为什么是"至少一个"而不是"全部"**：只点「保存」时「取消」仍可点，要求全部不可用会完全检测不到。
> 而"有按钮在 loading"就等价于"点过了、关闭路径正在等那个调用"，因为点击同时取消了倒计时。

> **为什么不等宽限期**：点击发起的请求是 fire-and-forget，关掉弹窗**不会取消它**；抖音自己的倒计时
> 路径也是同步关闭的。等待没有收益，只会让用户以为程序坏了。唯一的让步是状态需连续两次轮询成立
> （默认 400ms 轮询），以免把单帧重渲染误判成卡死。

"按钮不可用"覆盖多种信号：`pointer-events: none`、`disabled`、`aria-disabled="true"`、
`semi-button-loading` 类、**只带一个 spinner 子元素**。漏判是**静默**的（什么都不发生、也不打日志），
所以类名被改时还会退回 `[class*="trust-login-dialog-button"]`；并且弹窗存在但超过 9 秒仍未被判定为卡住时，
会打一条诊断日志把按钮形态写进去 —— 让下一次漏判**可查**。

### 渲染进程真的卡住

`app/recovery/responsiveness.js` 监听 `unresponsive` / `responsive`，弹一个「继续等待 / 重新加载页面」
的选择框。这里的宽限期是**合理**的（长时间同步任务不该触发无意义弹窗），与弹窗那条"立即关闭"方向相反 ——
判断依据是同一个问题：**等待能换来什么**。

## 测试

```console
npm test          # 单元：URL / 协议策略、配置导入导出与备份恢复、恢复逻辑
npm run test:e2e  # 端到端：真实 preload + 本地桩服务器
npm run test:all  # 全部
```

单元测试跑在 `node --test` 下，**不需要 Electron** —— 所以纯逻辑尽量挪进不依赖 `electron` 的模块
（`main/titles.js`、`platform/script-meta.js` 就是这么来的）。

剩下几个模块（`platform/downloads.js`、`web-contents-guard.js`）的行为本身就长在 Electron 对象上，
拆不干净，于是用 `test/helpers/electron-stub.js` 在 `require` 之前把 `electron` 换掉。原因很具体：
Electron 之外 `require('electron')` 返回的是**二进制路径字符串**，`const { app } = require('electron')`
得到 `undefined`，而 `platform/constants.js` 在加载期就调 `app.getPath('userData')`（那是刻意的，
见该文件注释）—— 于是模块根本 import 不进来。

| 测试文件 | 覆盖 |
| --- | --- |
| `titles` / `title-state` | 窗口标题的文案，以及"页面改标题不能冲掉修复提示" |
| `loading-document` | 加载页与导航白名单、空文档判定的交叉约束 |
| `url-policy` | 协议与域名判定（含仿冒域名） |
| `config-transfer` / `config-backup` / `gm-store` | 备份格式、导入校验、键与原型安全 |
| `blank-page` | 空文档与验证码判定、阶梯动作、时限与定时器回收 |
| `http` | 重定向跟随、取消、响应体上限（本地服务器，不出网） |
| `downloads` | 下载策略与 `GM_download` 的回调链 |
| `diagnostics` | 日志轮转与控制台消息折叠 |

端到端用本地 TLS 服务配合 Chromium host resolver 伪造一个真实的 `www.douyin.com`
（`douyin.com` 在 HSTS 预加载列表里，必须走 HTTPS），并加载生产用的 `app/preload/index.js` 与内置脚本。

> 端到端**不**覆盖下载策略，原因有两条：自定义协议在 Chromium 里根本不会启动下载，没有事件可断言；
> 而 e2e 骨架自建窗口与 IPC，并不跑 `app/main.js`，也就碰不到 `lifecycle.js` 里那次挂载。
> 所以"处理器到底有没有被调用"由单元测试用假 session 直接 emit `will-download` 钉住。

> `tools/e2e/certs/` 下的自签证书不入版本管理，测试运行时用 `openssl` 自动生成。
>
> 测试传了 `--no-proxy-server`：本机若有代理，Chromium 会把请求交给代理而不做本地解析，
> `host-resolver-rules` 失效，测试会**悄悄打到真实的 douyin.com**。每个用例都断言
> `window.__douyinDesktopLocalStub`，证明自己确实跑在桩页面上。
>
> 运行器会清掉 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`：前者会让 Electron 退化成普通 Node，
> 导致所有用例以难以理解的方式失败。手动跑单个 e2e 脚本时同样要清 ——
> `ELECTRON_RUN_AS_NODE=`（赋空值）**不等于**取消设置。

## 打包与发布

```console
npm run dist            # 便携版 → dist/抖音 x.y.z.exe
npm run dist:installer  # 安装版 → dist/抖音 Setup x.y.z.exe（NSIS，单用户，一键安装）
npm run clean:stale     # 清理历史遗留的构建目录
```

两个产物只差打包方式，代码与 profile 完全相同 —— 但**启动耗时差约 12.7 秒**，原因见
「[启动耗时](#启动耗时日志从哪一刻开始算)」。便携版给不想安装的场景，安装版给在意启动速度的场景。

`dist:installer` 刻意**没有** `predist`：清 `dist/` 只应在一次构建序列的开头做一次，否则第二个
产物会把第一个删掉。所以顺序是 `npm run dist && npm run dist:installer`。

安装版的 `deleteAppDataOnUninstall: false` 是刻意的：卸载不该顺手删掉 `userData`，那里有登录态和
脚本配置。

网络受限时先设镜像：把 `ELECTRON_MIRROR` 设为 `https://registry.npmmirror.com/-/binary/electron/`。
不要设 `ELECTRON_BUILDER_BINARIES_MIRROR` —— 它会改变 NSIS 工具链的缓存 key 触发重新下载，
本机已缓存过原始来源时反而容易撞上 Windows 的 EPERM。

### 构建前会先清空 `dist/`

`npm run dist` 会先跑 `predist` → `tools/build/clean-dist.js`。

原因：electron-builder **无法替换**已存在的 `dist/win-unpacked` —— 它先写 `win-unpacked.tmp`
再改名覆盖，而 Windows 在旧目录还在时拒绝这次改名（EPERM）。早先的绕过办法是手动把 `dist` 移开，
代价是每次构建都留下一个约 470 MB 的 `dist.prev.<时间戳>`。改成先删再建，两个问题一起消失；
删不掉时**明确失败并说明原因**（通常是便携版还在跑），而不是留下半删状态。

> 别用 `npm run dist --dry-run` 试跑：`--dry-run` 只对 npm 自身生效，**`predist` 照样会执行**。

历史遗留目录用 `npm run clean:stale` 清理。它会**点名**是哪个文件被别的进程打开着 ——
Windows 不允许删除已打开的文件，这是共享冲突而**不是权限问题**（改权限或夺取所有权都没用），
所以不点名的话完全没法排查。

发布：打 tag，用 `gh release create` 上传两个产物。资产名用 **ASCII**（`x.y.z.exe` / `x.y.z-setup.exe`，
把文件复制一份再上传），与历史 release 的 `0.2.0.exe` 保持一致，便于脚本按固定规则下载。
GitHub 连接不稳时给命令加重试，并先查是否已留下带资产的草稿，避免重复上传上百 MB。

## 排查手册

`tools/inspect/` 里的探针通过 CDP 连到**正在运行**的 app，只回答"现在到底发生了什么"，
输出是给人看的 JSON。它们**不是测试**：单元测试在 `test/`，端到端在 `tools/e2e/`。
完整索引见 `tools/inspect/README.md`。

| 症状 | 手段 |
| --- | --- |
| 页面渲染了没有 | `black-screen-probe.js` |
| 服务器到底给了什么 | `navigation-status-probe.js`（状态码 / 响应头）、`response-body-probe.js`（响应体：空响应 / 反爬挑战 / 真实页面） |
| 复现"服务器不给页面" | `simulate-refused-document.js`（单次）、`simulate-persistent-refusal.js`（持续，验证整条阶梯） |
| 会话与存储 | `session-cookie-probe.js`、`cookie-transfer-probe.js`、`clear-storage-probe.js` |
| 弹窗形态与关闭耗时 | `frozen-dialog-probe.js`、`invoke-dialog-handler.js`、`measure-dialog-close.js` |
| 是我们的壳还是环境 | `plain-electron-probe.js`（纯 Electron，不带 preload 与脚本） |

**启动即退出（GPU 子进程）**：现象是双击后一闪而过，日志里连续若干条
`GPU process exited unexpectedly: exit_code=1`，最后 `FATAL: GPU process isn't usable. Goodbye.`。

这是 Chromium 自己的行为，**与应用代码无关**：同机同源码的开发运行与打包版会一起出现，而应用自己的
运行日志里 GPU 事件为 0。逐参数实测：`--in-process-gpu` / `--disable-gpu-sandbox` / `--no-sandbox`
都能正常启动；`--disable-gpu-process-crash-limit` 不中止但 26 秒内重试 436 次，不可用。
指向 **GPU 进程的沙箱初始化**。绕过：`npm start -- --in-process-gpu`；一般重启机器即可恢复。

**文件被占用、删不掉**：先确认没有残留的 app 进程，再用 Process Explorer 的 Ctrl+F（Find Handle）
查持有者。报共享冲突而不是权限错误，说明确实有进程打开着它，改权限没有用。

**行为异常、怀疑是环境**：用 `plain-electron-probe.js` 做对照 —— 同一份代码换干净 profile 或纯
Electron，一步就能把"我们的代码"和"环境 / 持久化状态"切开。
