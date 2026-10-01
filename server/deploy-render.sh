#!/bin/bash
# ═══════════════════════════════════════════════
#  WristBili 帧解码服务器 - Render.com 一键部署
# ═══════════════════════════════════════════════
#
# 使用方法：
#   1. 确保已安装 GitHub CLI (gh) 并已登录
#   2. 运行此脚本: ./deploy-render.sh
#   3. 脚本会自动创建 GitHub 仓库并推送代码
#   4. 然后打开 Render 部署页面
#
# ───────────────────────────────────────────────

set -e

SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_NAME="wristbili-server"
REPO_DESC="WristBili video frame decoding server for smartwatch"

echo "═══════════════════════════════════════════════"
echo "  WristBili 服务器 Render.com 部署脚本"
echo "═══════════════════════════════════════════════"
echo ""

# 检查 gh CLI
if ! command -v gh &> /dev/null; then
    echo "❌ 未找到 GitHub CLI (gh)"
    echo ""
    echo "请先安装 GitHub CLI："
    echo "  macOS:  brew install gh"
    echo "  Ubuntu: sudo apt install gh"
    echo "  Windows: winget install GitHub.cli"
    echo ""
    echo "安装后运行: gh auth login"
    echo "然后重新运行此脚本。"
    exit 1
fi

# 检查是否已登录 GitHub
if ! gh auth status &> /dev/null; then
    echo "❌ GitHub CLI 未登录"
    echo "请运行: gh auth login"
    exit 1
fi

echo "✅ GitHub CLI 已就绪"
echo ""

# 创建临时 Git 仓库
TEMP_DIR=$(mktemp -d)
echo "📁 创建临时目录: $TEMP_DIR"
cp "$SERVER_DIR/video-frame-server.js" "$TEMP_DIR/"
cp "$SERVER_DIR/package.json" "$TEMP_DIR/"
cp "$SERVER_DIR/Dockerfile" "$TEMP_DIR/"
cp "$SERVER_DIR/render.yaml" "$TEMP_DIR/"

cd "$TEMP_DIR"
git init
git add -A
git commit -m "WristBili frame server - initial deploy"

# 创建 GitHub 仓库
echo ""
echo "🚀 创建 GitHub 仓库: $REPO_NAME"
gh repo create "$REPO_NAME" --public --description "$REPO_DESC" --source=. --push

# 获取仓库 URL
REPO_URL=$(gh repo view "$REPO_NAME" --json url -q .url)
echo ""
echo "✅ GitHub 仓库已创建: $REPO_URL"
echo ""

# 打开 Render 部署页面
RENDER_DEPLOY_URL="https://render.com/deploy?repo=$(gh repo view "$REPO_NAME" --json nameWithOwner -q .nameWithOwner)"

echo "═══════════════════════════════════════════════"
echo "  部署步骤"
echo "═══════════════════════════════════════════════"
echo ""
echo "1. 打开浏览器访问 Render:"
echo "   https://dashboard.render.com/web/new"
echo ""
echo "2. 选择刚创建的 GitHub 仓库: $REPO_NAME"
echo ""
echo "3. 配置（render.yaml 会自动配置，确认以下设置）:"
echo "   - Runtime: Docker"
echo "   - Plan: Free"
echo "   - Dockerfile Path: ./Dockerfile"
echo ""
echo "4. 点击 'Create Web Service' 开始部署"
echo ""
echo "5. 等待 2-3 分钟构建完成后，Render 会分配一个公网地址"
echo "   格式如: https://wristbili-frame-server.onrender.com"
echo ""
echo "6. 在手环设置中:"
echo "   - 播放源 → 服务器"
echo "   - 服务器地址 → 填入 Render 分配的域名（不含 https://）"
echo "     如: wristbili-frame-server.onrender.com"
echo ""
echo "═══════════════════════════════════════════════"

# 尝试打开浏览器
if command -v xdg-open &> /dev/null; then
    xdg-open "https://dashboard.render.com/web/new" 2>/dev/null || true
elif command -v open &> /dev/null; then
    open "https://dashboard.render.com/web/new" 2>/dev/null || true
fi

echo ""
echo "部署完成后，请将 Render 分配的域名填入手环设置。"
echo "═══════════════════════════════════════════════"

# 清理临时目录
rm -rf "$TEMP_DIR"
