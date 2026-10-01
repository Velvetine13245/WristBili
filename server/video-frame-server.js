#!/usr/bin/env node
/**
 * WristBili 视频帧解码服务器
 * 
 * 功能：接收手环发来的视频 BVID/CID，从 B 站获取视频流，
 * 用 ffmpeg 解码拆分成帧图片，通过 HTTP 提供给手环播放。
 * 
 * 部署方式（Oracle Cloud Free Tier 推荐）：
 *   1. 注册 Oracle Cloud 账号，创建 ARM Ampere A1 实例（免费）
 *   2. 安装 Node.js 和 ffmpeg
 *   3. npm install
 *   4. node video-frame-server.js
 *   5. 在手环设置中填入服务器公网 IP:3000
 * 
 * 接口：
 *   GET  /api/frames?bvid=XXX&cid=XXX&cookie=XXX  → 启动解码并返回帧列表
 *   GET  /api/frame/:sessionId/:index              → 获取单帧图片
 *   GET  /api/status/:sessionId                    → 查询解码状态
 *   GET  /api/health                               → 健康检查
 */

const http = require('http')
const https = require('https')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const PORT = process.env.PORT || 3000
const FRAME_RATE = parseInt(process.env.FRAME_RATE) || 2  // 每秒提取帧数
const MAX_FRAMES = parseInt(process.env.MAX_FRAMES) || 600  // 最多帧数
const FRAME_WIDTH = 320  // 帧宽度（适配手环屏幕）
const FRAME_HEIGHT = 180  // 帧高度
const OUTPUT_DIR = path.join(os.tmpdir(), 'wristbili_frames')
const SESSION_TIMEOUT = 30 * 60 * 1000  // 30分钟过期

// 确保输出目录存在
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
}

// 会话存储
const sessions = new Map()

/**
 * HTTP GET 请求封装
 */
function httpGet(url, headers, timeout) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: headers || {},
      timeout: timeout || 15000
    }
    const req = https.get(url, options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('请求超时'))
    })
  })
}

/**
 * 从 B 站获取视频信息（CID 等）
 */
async function getVideoInfo(bvid, cookie) {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Accept': 'application/json'
  }
  if (cookie && cookie.length > 10) {
    headers['Cookie'] = cookie
  }
  const res = await httpGet(url, headers, 15000)
  const data = JSON.parse(res.body)
  if (data.code !== 0) {
    throw new Error('获取视频信息失败: ' + data.message)
  }
  return data.data
}

/**
 * 从 B 站获取视频播放地址
 */
async function getPlayUrl(bvid, cid, cookie) {
  const url = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=16&fnval=16&fnver=0&fourk=0`
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Accept': 'application/json'
  }
  if (cookie && cookie.length > 10) {
    headers['Cookie'] = cookie
  }
  const res = await httpGet(url, headers, 15000)
  const data = JSON.parse(res.body)
  if (data.code !== 0) {
    throw new Error('获取播放地址失败: ' + data.message)
  }
  // 优先 dash 格式（最低画质，减少带宽和解码压力）
  if (data.data && data.data.dash && data.data.dash.video && data.data.dash.video.length > 0) {
    const videoStream = data.data.dash.video[data.data.dash.video.length - 1]
    return { url: videoStream.baseUrl, type: 'dash' }
  }
  // 回退 durl 格式
  if (data.data && data.data.durl && data.data.durl.length > 0) {
    return { url: data.data.durl[0].url, type: 'durl' }
  }
  throw new Error('无法获取视频流地址')
}

/**
 * 用 ffmpeg 解码视频为帧图片
 */
function decodeVideoToFrames(videoUrl, sessionId, cookie) {
  return new Promise((resolve, reject) => {
    const sessionDir = path.join(OUTPUT_DIR, sessionId)
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true })
    }

    const framePattern = path.join(sessionDir, 'frame_%04d.jpg')
    
    // ffmpeg 命令：提取帧，缩放到手环尺寸
    // -headers: B站视频流需要 Referer 否则 403
    const ffmpegArgs = [
      '-headers', 'Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n',
      '-i', videoUrl,
      '-vf', `fps=${FRAME_RATE},scale=${FRAME_WIDTH}:${FRAME_HEIGHT}`,
      '-frames:v', String(MAX_FRAMES),
      '-q:v', '5',
      '-y',
      framePattern
    ]

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const session = sessions.get(sessionId)
    if (!session) {
      reject(new Error('会话不存在'))
      return
    }

    let stderrData = ''
    ffmpeg.stderr.on('data', (chunk) => {
      stderrData += chunk.toString()
      // 更新进度
      const frameMatch = stderrData.match(/frame=\s*(\d+)/g)
      if (frameMatch && frameMatch.length > 0) {
        const lastFrame = frameMatch[frameMatch.length - 1].match(/frame=\s*(\d+)/)
        if (lastFrame) {
          session.decodedFrames = parseInt(lastFrame[1])
        }
      }
    })

    ffmpeg.on('close', (code) => {
      if (code === 0 || code === 255) {
        // 统计生成的帧文件
        const files = fs.readdirSync(sessionDir)
          .filter(f => f.match(/^frame_\d+\.jpg$/))
          .sort()
        session.totalFrames = files.length
        session.status = 'ready'
        session.frames = files.map(f => `/api/frame/${sessionId}/${f.replace('frame_', '').replace('.jpg', '')}`)
        resolve(files.length)
      } else {
        session.status = 'error'
        session.error = 'ffmpeg 退出码: ' + code + ', stderr: ' + stderrData.substring(stderrData.length - 500)
        reject(new Error('ffmpeg 解码失败，退出码: ' + code))
      }
    })

    ffmpeg.on('error', (err) => {
      session.status = 'error'
      session.error = err.message
      reject(err)
    })
  })
}

/**
 * 获取本机 IP 地址
 */
function getLocalIP() {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return '127.0.0.1'
}

/**
 * 生成会话 ID
 */
function genSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6)
}

// 创建 HTTP 服务器
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = url.pathname

  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  // 健康检查
  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', ip: getLocalIP(), port: PORT }))
    return
  }

  // 获取帧列表（启动解码）
  if (pathname === '/api/frames') {
    const bvid = url.searchParams.get('bvid') || ''
    const cid = url.searchParams.get('cid') || ''
    const cookie = url.searchParams.get('cookie') || ''

    if (!bvid && !cid) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '缺少 bvid 或 cid 参数' }))
      return
    }

    try {
      // 如果没有 cid，先获取视频信息
      let actualCid = cid
      if (!actualCid && bvid) {
        const videoInfo = await getVideoInfo(bvid, cookie)
        actualCid = videoInfo.cid ? String(videoInfo.cid) : ''
      }
      if (!actualCid) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '无法获取 cid' }))
        return
      }

      // 检查是否已有同 cid 的会话
      let existingSession = null
      for (const [id, sess] of sessions) {
        if (sess.cid === actualCid && sess.status === 'ready') {
          existingSession = id
          break
        }
      }

      if (existingSession) {
        const sess = sessions.get(existingSession)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          sessionId: existingSession,
          status: 'ready',
          totalFrames: sess.totalFrames,
          frames: sess.frames
        }))
        return
      }

      // 创建新会话
      const sessionId = genSessionId()
      sessions.set(sessionId, {
        id: sessionId,
        bvid,
        cid: actualCid,
        status: 'decoding',
        totalFrames: 0,
        decodedFrames: 0,
        frames: [],
        createdAt: Date.now()
      })

      // 异步开始解码
      getPlayUrl(bvid, actualCid, cookie)
        .then(({ url: videoUrl }) => {
          return decodeVideoToFrames(videoUrl, sessionId, cookie)
        })
        .then((count) => {
          console.log(`[会话 ${sessionId}] 解码完成，共 ${count} 帧`)
        })
        .catch((err) => {
          console.error(`[会话 ${sessionId}] 解码失败:`, err.message)
          const sess = sessions.get(sessionId)
          if (sess) {
            sess.status = 'error'
            sess.error = err.message
          }
        })

      // 立即返回会话 ID，客户端轮询状态
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        sessionId,
        status: 'decoding',
        totalFrames: 0,
        frames: []
      }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // 查询解码状态
  const statusMatch = pathname.match(/^\/api\/status\/(.+)$/)
  if (statusMatch) {
    const sessionId = statusMatch[1]
    const sess = sessions.get(sessionId)
    if (!sess) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '会话不存在' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      sessionId,
      status: sess.status,
      totalFrames: sess.totalFrames,
      decodedFrames: sess.decodedFrames,
      frames: sess.frames,
      error: sess.error || null
    }))
    return
  }

  // 获取单帧图片
  const frameMatch = pathname.match(/^\/api\/frame\/([^/]+)\/(\d+)$/)
  if (frameMatch) {
    const sessionId = frameMatch[1]
    const frameNum = parseInt(frameMatch[2])
    const paddedNum = String(frameNum).padStart(4, '0')
    const framePath = path.join(OUTPUT_DIR, sessionId, `frame_${paddedNum}.jpg`)

    if (!fs.existsSync(framePath)) {
      res.writeHead(404)
      res.end('Frame not found')
      return
    }

    const img = fs.readFileSync(framePath)
    res.writeHead(200, { 'Content-Type': 'image/jpeg' })
    res.end(img)
    return
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

// 定期清理过期会话
setInterval(() => {
  const now = Date.now()
  for (const [id, sess] of sessions) {
    if (now - sess.createdAt > SESSION_TIMEOUT) {
      const sessionDir = path.join(OUTPUT_DIR, id)
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true })
      }
      sessions.delete(id)
      console.log(`[清理] 删除过期会话 ${id}`)
    }
  }
}, 5 * 60 * 1000)

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP()
  console.log('═══════════════════════════════════════════')
  console.log('  WristBili 视频帧解码服务器')
  console.log('═══════════════════════════════════════════')
  console.log(`  本机地址:  http://${ip}:${PORT}`)
  console.log(`  健康检查:  http://${ip}:${PORT}/api/health`)
  console.log(`  帧率:     ${FRAME_RATE} fps`)
  console.log(`  最大帧数:  ${MAX_FRAMES}`)
  console.log(`  帧尺寸:   ${FRAME_WIDTH}x${FRAME_HEIGHT}`)
  console.log(`  临时目录:  ${OUTPUT_DIR}`)
  console.log('───────────────────────────────────────────')
  console.log('  在手环设置 → 播放源 → 服务器')
  console.log(`  填入地址: ${ip}:${PORT}`)
  console.log('═══════════════════════════════════════════')
})
