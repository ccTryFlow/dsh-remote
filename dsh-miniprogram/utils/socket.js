const { RELAY_BASE } = require('./config')
const { getUser } = require('./api')

function createRelaySocket(deviceId, port) {
  const base = RELAY_BASE.replace(/^http/, 'ws')
  const user = getUser()
  const pending = new Map()
  let seq = 0
  const socket = { onclose: null, onEvent: null, onready: null }

  const task = wx.connectSocket({
    url: `${base}/client?user=${encodeURIComponent(user)}&deviceId=${deviceId}&port=${port}`,
  })

  let opened = false
  let dead = false
  const sendQueue = []
  const rawSend = (data) => {
    if (opened) task.send({ data })
    else sendQueue.push(data)
  }
  task.onOpen(() => {
    opened = true
    for (const data of sendQueue) task.send({ data })
    sendQueue.length = 0
    if (socket.onready) socket.onready()
  })

  task.onMessage((msg) => {
    let frame
    try { frame = JSON.parse(msg.data) } catch { return }
    if (frame.t === 'ev') {
      if (socket.onEvent !== null) socket.onEvent(frame)
      return
    }
    if (frame.t === 'res' && pending.has(frame.id)) {
      const { resolve, timer } = pending.get(frame.id)
      clearTimeout(timer)
      pending.delete(frame.id)
      resolve(frame)
    }
  })
  let lastErr = ''
  task.onClose((e) => {
    dead = true
    const info = { code: e && e.code, reason: e && e.reason, errMsg: lastErr }
    console.log('[relay-ws] closed', JSON.stringify(info))
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(new Error('relay connection closed'))
    }
    pending.clear()
    if (socket.onclose) socket.onclose(info)
  })
  task.onError((err) => {
    lastErr = (err && err.errMsg) || 'unknown error'
    console.error('[relay-ws] error', lastErr)
    task.close({})
  })

  socket.request = (method, path, body) => new Promise((resolve, reject) => {
    const id = `req-${++seq}-${Date.now()}`
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('request timeout'))
    }, 15000)
    pending.set(id, { resolve, reject, timer })
    rawSend(JSON.stringify({ t: 'req', id, method, path, body }))
  })
  socket.close = () => task.close({})
  socket.isOpen = () => opened && !dead
  return socket
}

module.exports = { createRelaySocket }
