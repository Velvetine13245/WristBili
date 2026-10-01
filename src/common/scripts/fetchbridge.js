/**
 * FetchBridge v3 协议客户端
 *
 * 严格按照 AstroBox-NG-Plugin-MiWear-InterconnectFetch PROTOCOL.md v3 规范实现。
 * 通过 Vela 快应用 @system.interconnect 通道与网桥插件交换 HTTP 请求/响应。
 *
 * 协议要点：
 * - 传输层：QAIC interconnect 通道，交换 UTF-8 JSON 字符串
 * - 握手：__hs__ 三次 ping-pong (count 0→1→2)，附带 caps 能力协商
 * - 请求：tag:"fetch"，含 url/method/headers/body/raw
 * - 响应(单消息)：tag:"fetch"，resp 含 ok/status/headers/body/bodyEncoding/compression
 * - 响应(分片)：头部 tag:"fetch" + chunked:true，后续 tag:"fetch-chunk" 逐片
 * - ACK流控(v3)：tag:"fetch-ack"，累计确认滑动窗口
 *
 * 兼容承诺：必须保留 v1 单消息 base64/text 响应处理能力作为兜底。
 */

import fetch from '@system.fetch'
import storage from '@system.storage'
import interconnect from '@system.interconnect'

// ============================================================
// 常量定义 (严格遵循 PROTOCOL.md §3.4 插件默认值)
// ============================================================
var LOCAL_PROTOCOL_VERSION = 3
var LOCAL_CHUNK_SUPPORTED = true
var LOCAL_MAX_CHUNK_SIZE = 4096
var LOCAL_ENCODINGS = ['text', 'base64', 'hex']
var LOCAL_COMPRESSIONS = ['none']
var LOCAL_ACK_SUPPORTED = true
var LOCAL_ACK_WINDOW = 4

var HANDSHAKE_TIMEOUT = 8000   // 握手超时 8s
var FETCH_DEFAULT_TIMEOUT = 30000 // fetch 默认超时 30s
var CHUNK_ASSEMBLY_TIMEOUT = 60000 // 分片重组超时 60s
var MAX_UNCHUNKED_WIRE_LEN = 16384 // legacy 单消息上限

// ============================================================
// Base64 解码器 (纯 JS 实现，不依赖 atob)
// ============================================================
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64Decode(str) {
  var len = str.length
  var out = []
  var i = 0
  // 去除可能的 padding 和空白
  str = str.replace(/[^A-Za-z0-9+/]/g, '')
  len = str.length
  while (i < len) {
    var c1 = B64.indexOf(str.charAt(i++))
    var c2 = B64.indexOf(str.charAt(i++))
    var c3 = B64.indexOf(str.charAt(i++))
    var c4 = B64.indexOf(str.charAt(i++))
    if (c1 < 0 || c2 < 0) break
    var byte1 = (c1 << 2) | (c2 >> 4)
    out.push(byte1)
    if (c3 >= 0 && c3 < 64) {
      var byte2 = ((c2 & 15) << 4) | (c3 >> 2)
      out.push(byte2)
      if (c4 >= 0 && c4 < 64) {
        var byte3 = ((c3 & 3) << 6) | c4
        out.push(byte3)
      }
    }
  }
  return out
}

function bytesToUtf8(bytes) {
  var str = ''
  var i = 0
  while (i < bytes.length) {
    var b = bytes[i]
    if (b < 0x80) {
      str += String.fromCharCode(b)
      i++
    } else if (b >= 0xC0 && b < 0xE0) {
      var c2 = bytes[i + 1] || 0
      str += String.fromCharCode(((b & 31) << 6) | (c2 & 63))
      i += 2
    } else if (b >= 0xE0 && b < 0xF0) {
      var c2 = bytes[i + 1] || 0
      var c3 = bytes[i + 2] || 0
      str += String.fromCharCode(((b & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63))
      i += 3
    } else if (b >= 0xF0) {
      var c2 = bytes[i + 1] || 0
      var c3 = bytes[i + 2] || 0
      var c4 = bytes[i + 3] || 0
      var cp = ((b & 7) << 18) | ((c2 & 63) << 12) | ((c3 & 63) << 6) | (c4 & 63)
      cp = cp - 0x10000
      str += String.fromCharCode(0xD800 + (cp >> 10))
      str += String.fromCharCode(0xDC00 + (cp & 1023))
      i += 4
    } else {
      i++
    }
  }
  return str
}

function hexDecode(str) {
  var bytes = []
  var i = 0
  str = str.replace(/[^0-9a-fA-F]/g, '')
  while (i + 1 < str.length) {
    bytes.push(parseInt(str.substr(i, 2), 16))
    i += 2
  }
  return bytes
}

/**
 * 按 bodyEncoding 解码字符串为最终文本
 */
function decodeBody(encodedStr, encoding) {
  if (!encodedStr) return ''
  if (encoding === 'text' || !encoding) {
    return encodedStr
  }
  if (encoding === 'base64') {
    var bytes = base64Decode(encodedStr)
    return bytesToUtf8(bytes)
  }
  if (encoding === 'hex') {
    var bytes = hexDecode(encodedStr)
    return bytesToUtf8(bytes)
  }
  // 兜底：按 base64 处理 (v1/v2 baseline)
  return bytesToUtf8(base64Decode(encodedStr))
}

// ============================================================
// FetchBridge 核心状态
// ============================================================
var state = {
  session: null,
  connected: false,
  handshakeDone: false,
  negotiated: null,
  enabled: false,
  reqIdCounter: 0,
  // 待处理请求: { id -> { success, fail, timer } }
  pending: {},
  // 分片重组缓冲: { id -> { count, total, received, chunks, info, timer } }
  chunkBuffers: {},
  // 握手回调队列
  handshakeCallbacks: [],
  // 会话状态回调
  statusCallback: null,
  // 重连计时器
  reconnectTimer: null,
  // 连续失败计数
  failCount: 0
}

// ============================================================
// 内部工具
// ============================================================
function genId() {
  state.reqIdCounter = state.reqIdCounter + 1
  return 'r' + state.reqIdCounter
}

function safeJsonParse(str) {
  if (typeof str === 'object') return str
  try {
    return JSON.parse(str)
  } catch (e) {
    return null
  }
}

function notifyStatus(status) {
  if (state.statusCallback) {
    try {
      state.statusCallback(status)
    } catch (e) {}
  }
}

/**
 * 发送 JSON 消息到 interconnect 通道
 */
function sendMessage(obj) {
  if (!state.session) {
    return false
  }
  var str = JSON.stringify(obj)
  try {
    state.session.send({
      data: str,
      success: function() {},
      fail: function() {
        state.failCount++
        if (state.failCount > 5) {
          state.connected = false
          notifyStatus('disconnected')
        }
      }
    })
    return true
  } catch (e) {
    return false
  }
}

// ============================================================
// 握手协议 (PROTOCOL.md §3)
// ============================================================

/**
 * 构建本端 caps 对象
 */
function buildCaps() {
  return {
    version: LOCAL_PROTOCOL_VERSION,
    chunk: LOCAL_CHUNK_SUPPORTED,
    maxChunkSize: LOCAL_MAX_CHUNK_SIZE,
    encodings: LOCAL_ENCODINGS,
    compressions: LOCAL_COMPRESSIONS,
    ack: LOCAL_ACK_SUPPORTED,
    ackWindow: LOCAL_ACK_WINDOW
  }
}

/**
 * 发起握手 (count=0)
 */
function startHandshake(callback) {
  if (state.handshakeDone) {
    if (callback) callback(true)
    return
  }
  if (callback) {
    state.handshakeCallbacks.push(callback)
  }
  // 超时保护
  var hsTimer = setTimeout(function() {
    if (!state.handshakeDone) {
      var cbs = state.handshakeCallbacks
      state.handshakeCallbacks = []
      for (var i = 0; i < cbs.length; i++) {
        cbs[i](false)
      }
      notifyStatus('handshake_timeout')
    }
  }, HANDSHAKE_TIMEOUT)

  // 存储超时计时器以便握手完成后清除
  state._hsTimer = hsTimer

  // 发送 count=0 握手包
  sendMessage({
    tag: '__hs__',
    count: 0,
    caps: buildCaps()
  })
}

/**
 * 处理收到的握手消息
 */
function handleHandshake(msg) {
  var count = msg.count
  var peerCaps = msg.caps || null

  if (peerCaps) {
    // 存储对端能力
    negotiateCaps(peerCaps)
  }

  if (count < 2) {
    // 回送 count+1
    sendMessage({
      tag: '__hs__',
      count: count + 1,
      caps: buildCaps()
    })
  }

  if (count >= 2 && !state.handshakeDone) {
    // 握手完成
    state.handshakeDone = true
    state.failCount = 0
    if (state._hsTimer) {
      clearTimeout(state._hsTimer)
      state._hsTimer = null
    }
    notifyStatus('handshake_done')
    // 触发所有等待握手的回调
    var cbs = state.handshakeCallbacks
    state.handshakeCallbacks = []
    for (var i = 0; i < cbs.length; i++) {
      cbs[i](true)
    }
  }
}

/**
 * 能力协商 (PROTOCOL.md §3.4)
 */
function negotiateCaps(peerCaps) {
  var peerVersion = peerCaps.version || 1
  var peerChunk = peerCaps.chunk === true
  var peerAck = peerCaps.ack === true

  var version = Math.min(peerVersion, LOCAL_PROTOCOL_VERSION)
  var chunked = LOCAL_CHUNK_SUPPORTED && peerChunk && version >= 2
  var ackWindow = (chunked && LOCAL_ACK_SUPPORTED && peerAck)
    ? Math.min(peerCaps.ackWindow || LOCAL_ACK_WINDOW, LOCAL_ACK_WINDOW)
    : 0

  // 编码交集（保留 peer 顺序）
  var encs = []
  if (peerCaps.encodings) {
    for (var i = 0; i < peerCaps.encodings.length; i++) {
      var enc = peerCaps.encodings[i]
      for (var j = 0; j < LOCAL_ENCODINGS.length; j++) {
        if (LOCAL_ENCODINGS[j] === enc && encs.indexOf(enc) < 0) {
          encs.push(enc)
        }
      }
    }
  }
  if (encs.length === 0) {
    encs = ['base64'] // v1/v2 baseline
  }

  // 压缩交集
  var comps = []
  if (peerCaps.compressions) {
    for (var i = 0; i < peerCaps.compressions.length; i++) {
      var cmp = peerCaps.compressions[i]
      for (var j = 0; j < LOCAL_COMPRESSIONS.length; j++) {
        if (LOCAL_COMPRESSIONS[j] === cmp && comps.indexOf(cmp) < 0) {
          comps.push(cmp)
        }
      }
    }
  }
  if (comps.length === 0) {
    comps = ['none']
  }

  state.negotiated = {
    version: version,
    chunked: chunked,
    chunkSize: LOCAL_MAX_CHUNK_SIZE,
    encodings: encs,
    compressions: comps,
    ackWindow: ackWindow
  }
}

// ============================================================
// Fetch 请求 (PROTOCOL.md §4)
// ============================================================

/**
 * 通过网桥发送 fetch 请求
 * options 与 @system.fetch.fetch 兼容
 */
function bridgeFetch(options) {
  if (!state.connected || !state.handshakeDone) {
    // 网桥未就绪，降级到直接 fetch
    directFetch(options)
    return
  }

  var id = genId()
  var timeout = options.timeout || FETCH_DEFAULT_TIMEOUT

  // 构建协议请求
  var reqMsg = {
    tag: 'fetch',
    id: id,
    url: options.url,
    options: {
      method: options.method || 'GET',
      headers: options.header || {},
      body: options.data || '',
      raw: false
    }
  }

  // 注册回调
  state.pending[id] = {
    success: options.success,
    fail: options.fail,
    responseType: options.responseType,
    timer: setTimeout(function() {
      var pending = state.pending[id]
      if (pending) {
        delete state.pending[id]
        // 清理可能的分片缓冲
        if (state.chunkBuffers[id]) {
          delete state.chunkBuffers[id]
        }
        if (pending.fail) {
          pending.fail({ code: -1, message: 'fetch timeout' })
        }
      }
    }, timeout)
  }

  // 发送请求
  if (!sendMessage(reqMsg)) {
    // 发送失败，降级
    var pending = state.pending[id]
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer)
      delete state.pending[id]
    }
    directFetch(options)
  }
}

/**
 * 直接 fetch 降级 (使用 @system.fetch)
 */
function directFetch(options) {
  var actualResponseType = options.responseType
  var needBytes = false
  if (actualResponseType === 'bytes') {
    needBytes = true
    actualResponseType = 'arraybuffer'
  }
  var fetchOpts = {
    url: options.url,
    responseType: actualResponseType || 'json',
    success: function(res) {
      if (needBytes && res.data) {
        var bytes = null
        if (res.data instanceof ArrayBuffer || res.data.byteLength !== undefined) {
          var u8 = new Uint8Array(res.data)
          bytes = []
          for (var bi2 = 0; bi2 < u8.length; bi2++) {
            bytes.push(u8[bi2])
          }
        } else if (typeof res.data === 'string') {
          bytes = []
          for (var i = 0; i < res.data.length; i++) {
            bytes.push(res.data.charCodeAt(i) & 0xff)
          }
        }
        res.data = bytes
      }
      if (options.success) options.success(res)
    },
    fail: options.fail
  }
  if (options.method) {
    fetchOpts.method = options.method
  }
  if (options.data) {
    fetchOpts.data = options.data
  }
  if (options.header) {
    fetchOpts.header = options.header
  }
  if (options.timeout) {
    fetchOpts.timeout = options.timeout
  }
  fetch.fetch(fetchOpts)
}

// ============================================================
// Fetch 响应处理 (PROTOCOL.md §5)
// ============================================================

/**
 * 处理 fetch 响应消息 (单消息或分片头部)
 */
function handleFetchResponse(msg) {
  var id = msg.id || ''
  var resp = msg.resp
  if (!resp) return

  var pending = state.pending[id]
  if (!pending) return

  // 检查是否是分片模式头部
  if (resp.chunked === true) {
    // 建立分片缓冲
    state.chunkBuffers[id] = {
      chunkCount: resp.chunkCount || 0,
      total: resp.chunkCount || 0,
      received: 0,
      chunks: {},
      bodyEncoding: resp.bodyEncoding || 'base64',
      compression: resp.compression || 'none',
      raw: resp.raw,
      ack: resp.ack === true,
      ackBase: 0,
      info: resp,
      timer: setTimeout(function() {
        if (state.chunkBuffers[id]) {
          delete state.chunkBuffers[id]
          var p = state.pending[id]
          if (p) {
            delete state.pending[id]
            if (p.timer) clearTimeout(p.timer)
            if (p.fail) {
              p.fail({ code: -1, message: 'chunk assembly timeout' })
            }
          }
        }
      }, CHUNK_ASSEMBLY_TIMEOUT)
    }
    notifyStatus('chunked_response_started')
    return
  }

  // 单消息模式 — 直接处理
  processSingleResponse(id, resp, pending)
}

/**
 * 处理单消息响应
 */
function processSingleResponse(id, resp, pending) {
  if (pending.timer) clearTimeout(pending.timer)
  delete state.pending[id]

  var body = resp.body || ''
  var encoding = resp.bodyEncoding
  if (!encoding) {
    // 缺省推断: raw=false⇒text, raw=true⇒base64
    encoding = resp.raw ? 'base64' : 'text'
  }

  // bytes 模式: 返回原始字节数组，不做 UTF-8 转换
  if (pending.responseType === 'bytes') {
    var rawBytes = null
    if (encoding === 'base64') {
      rawBytes = base64Decode(body)
    } else if (encoding === 'hex') {
      rawBytes = hexDecode(body)
    } else {
      rawBytes = []
      for (var bi = 0; bi < body.length; bi++) {
        rawBytes.push(body.charCodeAt(bi) & 0xff)
      }
    }
    if (pending.timer) clearTimeout(pending.timer)
    delete state.pending[id]
    if (pending.success) {
      pending.success({
        data: rawBytes,
        statusCode: resp.status || 200,
        headers: resp.headers || {}
      })
    }
    return
  }

  var decodedBody = body
  if (encoding !== 'text' && body) {
    decodedBody = decodeBody(body, encoding)
  }

  // 如果声明了压缩且不是 none，理论上需要解压
  // 但本端只支持 none，所以如果收到非 none 压缩，尝试按 base64 兜底解码
  if (resp.compression && resp.compression !== 'none') {
    // 本端不支持解压，尝试按 raw text 处理
    decodedBody = body
  }

  // 按 responseType 处理
  var finalData = decodedBody
  if (pending.responseType === 'json' && typeof finalData === 'string') {
    finalData = safeJsonParse(finalData)
    if (!finalData) {
      if (pending.fail) {
        pending.fail({ code: -1, message: 'JSON parse failed' })
      }
      return
    }
  }

  if (pending.success) {
    pending.success({
      data: finalData,
      statusCode: resp.status || 200,
      headers: resp.headers || {}
    })
  }
}

/**
 * 处理分片数据 (PROTOCOL.md §5.2)
 */
function handleFetchChunk(msg) {
  var id = msg.id || ''
  var seq = msg.seq
  var data = msg.data

  var buf = state.chunkBuffers[id]
  if (!buf) return

  // 按 seq 存储分片
  buf.chunks[seq] = data
  buf.received++

  // ACK 流控 (PROTOCOL.md §5.2.1)
  if (buf.ack) {
    sendAck(id, buf)
  }

  // 检查是否收齐
  if (buf.received >= buf.chunkCount) {
    // 尝试组装（可能乱序到达，检查连续性）
    tryAssembleChunks(id, buf)
  }
}

/**
 * 发送 fetch-ack (累计确认)
 */
function sendAck(id, buf) {
  // 计算 ack = 连续前沿
  var ack = 0
  for (var i = 0; i < buf.chunkCount; i++) {
    if (buf.chunks[i] !== undefined) {
      ack = i + 1
    } else {
      break
    }
  }
  buf.ackBase = ack
  sendMessage({
    tag: 'fetch-ack',
    id: id,
    ack: ack
  })
}

/**
 * 尝试组装分片
 */
function tryAssembleChunks(id, buf) {
  // 检查所有分片是否到齐
  var allReceived = true
  for (var i = 0; i < buf.chunkCount; i++) {
    if (buf.chunks[i] === undefined) {
      allReceived = false
      break
    }
  }
  if (!allReceived) return

  // 清除分片超时
  if (buf.timer) clearTimeout(buf.timer)

  // 拼接所有分片
  var encodedStr = ''
  for (var i = 0; i < buf.chunkCount; i++) {
    encodedStr += buf.chunks[i]
  }

  // 清理缓冲
  delete state.chunkBuffers[id]

  var pending = state.pending[id]
  if (!pending) return
  if (pending.timer) clearTimeout(pending.timer)
  delete state.pending[id]

  // 解码
  var encoding = buf.bodyEncoding || 'base64'
  var decodedBody = encodedStr
  if (encoding !== 'text') {
    decodedBody = decodeBody(encodedStr, encoding)
  }

  // 压缩处理 (本端仅支持 none)
  if (buf.compression && buf.compression !== 'none') {
    decodedBody = encodedStr // 兜底
  }

  // bytes 模式: 返回原始字节数组
  if (pending.responseType === 'bytes') {
    var chunkBytes = null
    if (encoding === 'base64') {
      chunkBytes = base64Decode(encodedStr)
    } else if (encoding === 'hex') {
      chunkBytes = hexDecode(encodedStr)
    } else {
      chunkBytes = []
      for (var ci = 0; ci < encodedStr.length; ci++) {
        chunkBytes.push(encodedStr.charCodeAt(ci) & 0xff)
      }
    }
    if (pending.success) {
      pending.success({
        data: chunkBytes,
        statusCode: buf.info.status || 200,
        headers: buf.info.headers || {}
      })
    }
    notifyStatus('chunked_response_complete')
    return
  }

  // 按 responseType 处理
  var finalData = decodedBody
  if (pending.responseType === 'json' && typeof finalData === 'string') {
    finalData = safeJsonParse(finalData)
    if (!finalData) {
      if (pending.fail) {
        pending.fail({ code: -1, message: 'JSON parse failed (chunked)' })
      }
      return
    }
  }

  if (pending.success) {
    pending.success({
      data: finalData,
      statusCode: buf.info.status || 200,
      headers: buf.info.headers || {}
    })
  }
  notifyStatus('chunked_response_complete')
}

// ============================================================
// 消息分发
// ============================================================
function onMessage(data) {
  if (!data) return
  var msg = null
  if (typeof data === 'string') {
    msg = safeJsonParse(data)
  } else if (typeof data === 'object') {
    msg = data
  }
  if (!msg || !msg.tag) return

  switch (msg.tag) {
    case '__hs__':
      handleHandshake(msg)
      break
    case 'fetch':
      handleFetchResponse(msg)
      break
    case 'fetch-chunk':
      handleFetchChunk(msg)
      break
    case 'fetch-ack':
      // 快应用侧通常不收到 fetch-ack，忽略
      break
    default:
      // 未知 tag，忽略 (PROTOCOL.md: 不得报错断开)
      break
  }
}

// ============================================================
// 会话管理
// ============================================================

/**
 * 创建 interconnect 会话
 */
function createSession() {
  if (state.session) {
    return
  }
  try {
    var session = interconnect.createSession({
      id: 'FetchBridge',
      onSuccess: function() {
        state.connected = true
        state.failCount = 0
        notifyStatus('connected')
        // 发起握手
        startHandshake()
      },
      onFailure: function() {
        state.connected = false
        state.session = null
        notifyStatus('connect_failed')
        scheduleReconnect()
      }
    })

    // 注册消息监听
    if (session) {
      session.onMessage(function(data) {
        onMessage(data)
      })
      state.session = session
    }
  } catch (e) {
    state.connected = false
    notifyStatus('interconnect_unavailable')
  }
}

/**
 * 重连调度
 */
function scheduleReconnect() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
  }
  if (!state.enabled) return
  state.reconnectTimer = setTimeout(function() {
    if (state.enabled && !state.connected) {
      createSession()
    }
  }, 5000)
}

/**
 * 关闭会话
 */
function closeSession() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = null
  }
  if (state.session) {
    try {
      state.session.close()
    } catch (e) {}
    state.session = null
  }
  state.connected = false
  state.handshakeDone = false
  state.negotiated = null
  // 清理所有待处理请求
  var ids = Object.keys(state.pending)
  for (var i = 0; i < ids.length; i++) {
    var p = state.pending[ids[i]]
    if (p && p.timer) clearTimeout(p.timer)
  }
  state.pending = {}
  state.chunkBuffers = {}
}

// ============================================================
// 公共 API
// ============================================================

export default {
  /**
   * 初始化网桥
   * 从 storage 读取开关状态，若开启则创建会话
   */
  init: function() {
    var self = this
    storage.get({
      key: 'bili_bridge_enabled',
      success: function(data) {
        if (data === 'on') {
          self.enable()
        }
      },
      fail: function() {}
    })
  },

  /**
   * 启用网桥
   */
  enable: function() {
    state.enabled = true
    storage.set({ key: 'bili_bridge_enabled', value: 'on' })
    if (!state.session) {
      createSession()
    }
    notifyStatus('enabling')
  },

  /**
   * 禁用网桥
   */
  disable: function() {
    state.enabled = false
    storage.set({ key: 'bili_bridge_enabled', value: 'off' })
    closeSession()
    notifyStatus('disabled')
  },

  /**
   * 切换开关
   */
  toggle: function() {
    if (state.enabled) {
      this.disable()
    } else {
      this.enable()
    }
  },

  /**
   * 获取连接状态
   */
  getStatus: function() {
    if (!state.enabled) return 'disabled'
    if (!state.connected) return 'connecting'
    if (!state.handshakeDone) return 'handshaking'
    return 'ready'
  },

  /**
   * 获取状态描述文本
   */
  getStatusText: function() {
    var s = this.getStatus()
    if (s === 'disabled') return '已关闭'
    if (s === 'connecting') return '连接中...'
    if (s === 'handshaking') return '握手协商中...'
    if (s === 'ready') return '已就绪'
    return '未知'
  },

  /**
   * 获取协商能力信息
   */
  getNegotiated: function() {
    return state.negotiated
  },

  /**
   * 获取协商能力描述文本
   */
  getNegotiatedText: function() {
    if (!state.negotiated) return '尚未协商'
    var n = state.negotiated
    var text = '协议版本: v' + n.version + '\n'
    text += '分片支持: ' + (n.chunked ? '是' : '否') + '\n'
    text += '分片大小: ' + n.chunkSize + ' 字节\n'
    text += '编码: ' + n.encodings.join(', ') + '\n'
    text += '压缩: ' + n.compressions.join(', ') + '\n'
    text += 'ACK流控: ' + (n.ackWindow > 0 ? '启用 (窗口=' + n.ackWindow + ')' : '未启用')
    return text
  },

  /**
   * 注册状态变更回调
   */
  onStatusChange: function(callback) {
    state.statusCallback = callback
  },

  /**
   * 网桥 fetch — 与 @system.fetch.fetch 接口兼容
   * 若网桥未就绪则自动降级到直接 fetch
   */
  fetch: function(options) {
    bridgeFetch(options)
  },

  /**
   * 检查网桥是否就绪
   */
  isReady: function() {
    return state.enabled && state.connected && state.handshakeDone
  },

  /**
   * 销毁
   */
  destroy: function() {
    closeSession()
    state.enabled = false
  }
}
