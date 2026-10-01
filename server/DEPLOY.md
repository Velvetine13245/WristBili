# WristBili 服务器部署指南（Render.com 免费版）

## Render.com 免费资源

Render.com 提供 [$TRAE_REF](https://render.com/docs/free.md) 永久免费的 Web 服务：
- 0.1 CPU / 512 MB RAM
- 750 小时/月（15 分钟无活动后自动休眠，有请求时自动唤醒）
- 自动 HTTPS
- 从 GitHub 仓库自动部署

## 快速部署（3 步）

### 第 1 步：准备 GitHub 账号

如果没有 GitHub 账号，前往 [github.com](https://github.com) 注册（免费）。

### 第 2 步：上传服务器代码到 GitHub

**方法 A - 一键部署脚本（推荐）**

在你的电脑上安装 GitHub CLI：
```bash
# macOS
brew install gh

# Ubuntu/Debian
sudo apt install gh

# Windows
winget install GitHub.cli
```

登录 GitHub：
```bash
gh auth login
```

运行部署脚本：
```bash
cd server
./deploy-render.sh
```

脚本会自动创建 GitHub 仓库并推送代码。

**方法 B - 手动上传**

1. 在 GitHub 创建新仓库 `wristbili-server`
2. 上传以下文件到仓库根目录：
   - `video-frame-server.js`
   - `package.json`
   - `Dockerfile`
   - `render.yaml`

### 第 3 步：在 Render.com 部署

1. 前往 [Render Dashboard](https://dashboard.render.com/web/new)
2. 连接你的 GitHub 账号
3. 选择 `wristbili-server` 仓库
4. Render 会自动识别 `render.yaml`，确认配置：
   - **Runtime**: Docker
   - **Plan**: Free
   - **Dockerfile Path**: `./Dockerfile`
5. 点击 "Create Web Service"
6. 等待 2-3 分钟构建完成
7. Render 分配地址，格式如：`wristbili-frame-server.onrender.com`

### 第 4 步：手环端配置

1. 在手环上打开 WristBili
2. **设置 → 播放源** → 切换到"服务器"
3. **设置 → 服务器地址** → 填入 Render 地址（不含 `https://`）
   - 如：`wristbili-frame-server.onrender.com`
4. 点击"测试连接"，显示"连接成功"即可
5. 打开视频，服务器自动解码视频为帧并发送到手环

## Render.com 注意事项

- 免费版在 15 分钟无活动后会休眠，首次唤醒约需 30 秒
- 512 MB RAM 适合短视频解码（< 5 分钟）
- 服务器会自动清理超过 30 分钟的临时帧文件
- 每月 750 小时免费额度，足够个人使用

## 备选方案：Oracle Cloud（更强大，永久免费）

如果需要更强的解码能力，参考 [Oracle Cloud 部署指南](#oracle-cloud-部署)

### Oracle Cloud 优势
- 4 核 ARM + 24 GB RAM（比 Render 强 50 倍）
- 10 TB/月出站流量
- 不休眠，7×24 小时运行
- 需要 5 分钟注册（含信用卡验证，不扣费）

### Oracle Cloud 部署步骤
1. 注册 [Oracle Cloud](https://www.oracle.com/cloud/free/)
2. 创建 ARM Ampere A1 实例（4 核 24 GB）
3. SSH 登录后执行：
```bash
sudo apt update && sudo apt install -y nodejs ffmpeg
git clone <你的GitHub仓库> ~/wristbili-server
cd ~/wristbili-server
node video-frame-server.js
```
4. 开放 3000 端口（iptables + OCI 安全列表）
5. 在手环设置中填入公网 IP:3000

## API 接口说明

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查，返回服务器状态和 IP |
| `/api/frames?bvid=XXX&cid=XXX&cookie=XXX` | GET | 启动解码，返回会话 ID |
| `/api/status/:sessionId` | GET | 查询解码进度和帧列表 |
| `/api/frame/:sessionId/:index` | GET | 获取单帧 JPEG 图片 |
