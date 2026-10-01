# WristBili - 手环轻量 B 站快应用

在智能手环上观看 B 站视频的快应用，支持视频帧播放、弹幕、点赞投币收藏、评论等功能。

## 版本

v2.1.0

## 功能特性

- 🎬 视频播放：基于 B 站 videoshot 接口的帧播放，支持 0.75x/1x/2x/4x 倍速
- 💬 弹幕：支持 protobuf 格式弹幕解析与滚动显示
- 👍 互动：点赞、投币、收藏、稍后再看
- 💬 评论：查看与发布评论
- 📱 全屏播放：竖屏全屏模式，沉浸式观看
- 🔄 多种播放源：封面帧、转码帧、服务器解码
- 📥 离线缓存：支持视频帧离线下载
- 🌙 暗色主题：适配手环屏幕

## 播放模式

### 1. 封面模式（默认）
使用视频封面图作为单帧展示，无需额外 API。

### 2. 转码模式（videoshot API）
调用 B 站 `x/player/videoshot` 接口获取雪碧图，通过图片 CDN 裁剪参数拆分为单帧播放。
- 接口：`https://api.bilibili.com/x/player/videoshot?bvid=BV号&cid=CID&index=1`
- 原理：返回的雪碧图（sprite sheet）中每格为一帧，利用 B 站图片 CDN 的 `@x-y-w-h` 裁剪参数逐帧提取
- 优点：无需服务器，直接调用 B 站官方接口
- 缺点：帧数较少，画质较低（160x90）

### 3. 服务器模式（ffmpeg 解码）
部署自建 Node.js 服务器，使用 ffmpeg 从 B 站视频流中解码拆帧。
- 优点：画质高、帧数多、可自定义帧率
- 缺点：需要部署服务器（推荐 Oracle Cloud 免费 ARM 实例）

服务器部署见 `server/` 目录。

## 目录结构

```
src/                    # 快应用源码
├── Fullscreen/         # 全屏播放页（竖屏）
├── Video/              # 视频详情页
├── Home/               # 首页
├── Search/             # 搜索
├── Comments/           # 评论
├── Settings/           # 设置
├── Developer/          # 关于
├── common/             # 公共资源
└── manifest.json       # 应用配置
server/                 # ffmpeg 视频帧解码服务器
├── video-frame-server.js
├── package.json
├── Dockerfile
└── DEPLOY.md
```

## 构建

```bash
npm install
npm run build
```

生成的 RPK 文件在 `dist/` 目录。

## 安装

将 RPK 文件通过快应用调试器或小米手环快应用安装工具安装到手环。

## 开源协议

[GNU AGPL-3.0](LICENSE)

本项目采用 GNU Affero General Public License v3.0 协议开源。
