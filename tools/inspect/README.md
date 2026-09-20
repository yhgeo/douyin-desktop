# 排查用探针

这些脚本通过 CDP 连到**正在运行**的 app，用来复现和测量，不参与构建：

```bash
npm start -- --remote-debugging-port=9222
node tools/inspect/black-screen-probe.js --port=9222
```

**它们不是测试。** 测试在 `test/`（单元）与 `tools/e2e/`（端到端，自带桩服务器）。
这里的东西只回答"现在到底发生了什么"，所以输出是给人看的 JSON，不是断言。

> 部分探针是为某个已经修好的问题写的一次性工具。保留它们是因为同一个问题复发时，
> 重新写一遍比读一遍贵得多 —— 下面的表说明了各自属于哪一类。

## 页面状态：服务器到底给了什么

| 脚本 | 用途 |
| --- | --- |
| `black-screen-probe.js` | 页面渲染了没有：`readyState`、body 子元素数、脚本数、样式数、错误 backlog |
| `navigation-status-probe.js` | 每次导航的状态码、mime、响应头（判断是否 403/空响应） |
| `response-body-probe.js` | 抓**响应体本身** —— 区分空响应、反爬挑战页（`_$jsvmprt`）、真实页面 |

三个是不同层次（DOM / 网络元数据 / 响应字节），互补而非重复。

## 复现「服务器不给页面」

| 脚本 | 用途 |
| --- | --- |
| `simulate-refused-document.js` | 只拒绝一次然后放开拦截，验证**单次修复**能成功 |
| `simulate-persistent-refusal.js` | 持续拒绝 N 秒，验证**阶梯升级与永不放弃**；是前者的超集，日常优先用它 |

两者都保持独立：前者是最小复现（一次拒绝），后者用来观察整条阶梯（`--hold=20000`）。

## 反爬挑战

| 脚本 | 用途 |
| --- | --- |
| `force-challenge-probe.js` | 删掉 `__ac_*` cookie 强制触发挑战，并对比两种文档的响应头 |

## 会话与存储

| 脚本 | 用途 |
| --- | --- |
| `session-cookie-probe.js` | 列出当前 cookie（名字、域、过期时间） |
| `cookie-transfer-probe.js` | 把一个实例的 cookie 注入另一个，做 A/B |
| `clear-storage-probe.js` | 清站点存储 / 强制重载；`--dry` 只读，`--types=` 指定范围 |

## 弹窗与卡顿（问题已修，工具保留）

| 脚本 | 用途 |
| --- | --- |
| `frozen-dialog-probe.js` | 卡住弹窗的形态：按钮 `pointer-events`、spinner、遮罩 |
| `invoke-dialog-handler.js` | 直接调用按钮的 React `onClick`，同时 hook DOM 移除调用 |
| `capture-dialog-exception.js` | 记录点击前后的异常与 backlog |
| `find-dialog-caller.js` | 在 bundle 里搜调用点（找 endpoint / 事件线） |
| `measure-dialog-close.js` | 测量自动关闭耗时，回归用 |
| `throttle-probe.js` | 计时器频率与 `visibilityState`，用于排除"被节流" |

## 播放器

| 脚本 | 用途 |
| --- | --- |
| `player-probe.js` | 全屏前后的播放器指标：内部分辨率 vs 显示尺寸、`devicePixelRatio`、CSS transform。`--page` 驱动"网页全屏"，`--url=` 直连视频页 |

## 环境对照：是我们的壳还是环境？

| 脚本 | 用途 |
| --- | --- |
| `plain-electron-probe.js` | 用**纯 Electron**（不带 preload 与用户脚本）打开同一页面。这是排查环境类问题最快的分界实验 |
