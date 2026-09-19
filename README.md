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
- 清除缓存与站点存储
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

## 打包 EXE

```powershell
npm run dist
```

输出位于 `dist/`：

- `抖音 Setup 0.1.0.exe`：Windows 安装包
- `抖音 0.1.0.exe`：便携式 EXE

## 脚本来源与许可

内置脚本来自 `WhiteSevs/TamperMonkeyScript`，脚本标注为 **GPL-3.0-only**。对应脚本源码保存在：

- `assets/douyin-optimization.user.js`

其依赖的 UMD 文件保存在：

- `vendor/`

更新脚本前请阅读并遵循上游项目的许可和发布要求。
