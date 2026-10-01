FROM node:20-slim

# 安装 ffmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 创建工作目录
WORKDIR /app

# 复制 package.json 并安装依赖
COPY package.json ./
RUN npm install --production

# 复制服务器代码
COPY video-frame-server.js ./

# 设置临时目录
RUN mkdir -p /tmp/wristbili_frames

# 暴露端口（Render 会设置 PORT 环境变量）
ENV PORT=3000
EXPOSE 3000

# 启动服务器
CMD ["node", "video-frame-server.js"]
