import { createServer } from 'node:http'
import { randomBytes, randomInt } from 'node:crypto'
import { hostname, type, release, platform, homedir } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import QRCode from 'qrcode'

export const name = 'relay-lan'
export const inject = []

const CODE_TTL_MS = 5 * 60_000
const CODE_ALPHABET = '0123456789'

function statePath(config) {
  return config.statePath ?? join(homedir(), '.dsh', 'relay-lan.json')
}

function loadState(config) {
  try {
    return JSON.parse(readFileSync(statePath(config), 'utf8'))
  } catch {
    return {}
  }
}

function saveState(config, state) {
  const file = statePath(config)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2))
}

function mapSurface(snapshot) {
  const messages = []
  let prevTime = null
  for (const event of snapshot.events ?? []) {
    if (event.type === 'user/message') {
      if ((event.data?.source?.kind ?? 'user') !== 'user') continue
      const text = (event.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      messages.push({ kind: 'user', text, seq: event.seq, ...(typeof event.time === 'number' ? { time: event.time } : {}) })
      if (typeof event.time === 'number') prevTime = event.time
      continue
    }
    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content ?? []
      let text = ''
      let reasoning = null
      for (const block of blocks) {
        if (block.type === 'text') text += block.text
        else if (block.type === 'reasoning' && reasoning === null) reasoning = block.text
      }
      const usage = event.data?.usage
      const tokens = usage === undefined ? null : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      let metrics = null
      if (typeof event.time === 'number' && prevTime !== null) {
        metrics = {
          time: event.time,
          runMs: Math.max(0, event.time - prevTime),
          out: usage !== undefined && Number.isFinite(usage.outputTokens) ? usage.outputTokens : null,
        }
      }
      messages.push({
        kind: 'agent',
        text,
        reasoning,
        tokens,
        seq: event.seq,
        ...(metrics !== null ? { metrics } : {}),
      })
      if (typeof event.time === 'number') prevTime = event.time
      continue
    }
    if (event.type === 'tool/call') {
      messages.push({ kind: 'tool', name: event.data?.name ?? 'tool', seq: event.seq })
      if (typeof event.time === 'number') prevTime = event.time
    }
  }
  return messages
}

function mintCode() {
  let code = ''
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

export function apply(ctx, config) {
  const log = (...args) => console.log('[relay-lan]', ...args)
  const host = config.host ?? '0.0.0.0'
  const port = Number(process.env.RELAY_LAN_PORT ?? config.port ?? 4010)
  const webPort = Number(config.webPort ?? ctx.webStartup?.port ?? 3080)
  const localApi = `http://127.0.0.1:${String(webPort)}`

  const state = loadState(config)
  state.deviceId ??= randomBytes(16).toString('hex')
  state.binding ??= null
  saveState(config, state)

  let pairing = null
  const printPairingCode = (kind, code) => {
    log(`${kind} ${code} (expires in 5 min) — scan this QR or enter the code in the mini program to bind this computer`)
    QRCode.toString(code, { type: 'terminal', small: true }).then((qr) => console.log(qr), () => {})
  }
  const issuePairingCode = () => {
    pairing = { code: mintCode(), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 }
    printPairingCode('pairing code', pairing.code)
  }
  if (state.binding === null) issuePairingCode()

  let clientSocket = null
  const send = (ws, frame) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(frame))
  }

  const downlinks = { mux: null, host: null, closing: false, disposed: false, reopenTimer: null }

  const closeDownlinks = () => {
    downlinks.closing = true
    for (const key of ['mux', 'host']) {
      const ws = downlinks[key]
      downlinks[key] = null
      if (ws !== null) ws.terminate()
    }
    downlinks.closing = false
  }

  const needDownlinks = () => clientSocket !== null || cloud.authed

  const openDownlinks = () => {
    if (downlinks.disposed || !needDownlinks()) return
    if (downlinks.mux !== null || downlinks.host !== null) return
    if (downlinks.reopenTimer !== null) { clearTimeout(downlinks.reopenTimer); downlinks.reopenTimer = null }
    for (const kind of ['mux', 'host']) {
      if (downlinks[kind] !== null) continue
      const path = kind === 'mux' ? '/api/events.mux' : '/api/events.host'
      const ws = new WebSocket(localApi.replace(/^http/, 'ws') + path)
      downlinks[kind] = ws
      ws.on('message', (data) => {
        let frame
        try { frame = JSON.parse(String(data)) } catch { return }
        const wrapped = { t: 'ev', s: kind, frame }
        if (clientSocket !== null && clientSocket.readyState === 1) clientSocket.send(JSON.stringify(wrapped))
        if (cloud.authed) cloudSend(wrapped)
      })
      ws.on('error', () => {})
      ws.on('close', () => {
        if (downlinks[kind] === ws) downlinks[kind] = null
        if (downlinks.closing || downlinks.disposed || !needDownlinks()) return
        log('downlink ' + kind + ' closed — reopening both in 5s')
        closeDownlinks()
        if (downlinks.reopenTimer !== null) return
        downlinks.reopenTimer = setTimeout(() => {
          downlinks.reopenTimer = null
          if (needDownlinks()) openDownlinks()
        }, 5000)
      })
    }
  }

  const refreshDownlinks = () => {
    if (needDownlinks()) {
      if (downlinks.mux === null && downlinks.host === null && !downlinks.closing) openDownlinks()
    } else {
      closeDownlinks()
    }
  }

  const cloudUrl = (process.env.RELAY_CLOUD_URL ?? config.cloudUrl ?? '') || null
  const keepPairing = !/^(0|false|off)$/i.test(String(process.env.RELAY_CLOUD_PAIRING ?? config.keepPairing ?? '0'))
  const cloud = { ws: null, token: state.cloud?.token ?? null, authed: false, disposed: false, reissueTimer: null, qrShown: false }

  const cloudSend = (frame) => {
    if (cloud.ws !== null && cloud.ws.readyState === 1) cloud.ws.send(JSON.stringify(frame))
  }

  const cloudPairingStart = () => {
    cloudSend({ t: 'pairing.start', deviceId: state.deviceId, port: webPort, name: hostname() + ' (dsh)', info: { os: type() + ' ' + release(), platform: platform(), host: hostname() } })
  }

  function openCloud() {
    if (cloud.disposed || cloudUrl === null) return
    const base = cloudUrl.endsWith('/') ? cloudUrl.slice(0, -1) : cloudUrl
    const ws = new WebSocket(base + '/device')
    cloud.ws = ws
    cloud.qrShown = false
    const issuePairingIfWanted = () => { if (cloud.token === null || keepPairing) cloudPairingStart() }
    ws.on('open', () => {
      log('cloud uplink open: ' + cloudUrl)
      if (cloud.token !== null) ws.send(JSON.stringify({ t: 'auth', token: cloud.token }))
      cloudPairingStart()
      refreshDownlinks()
    })
    ws.on('message', (data) => {
      let frame
      try { frame = JSON.parse(String(data)) } catch { return }
      if (frame.t === 'pairing.code') {
        if (!cloud.qrShown) {
          printPairingCode(cloud.token === null ? 'cloud pairing code' : 'cloud pairing code (only needed to bind another phone/version; this computer is already bound)', frame.code)
          cloud.qrShown = true
        } else {
          log(`cloud pairing code refreshed: ${frame.code} (expires in 5 min)`)
        }
        if (cloud.reissueTimer !== null) clearTimeout(cloud.reissueTimer)
        cloud.reissueTimer = setTimeout(issuePairingIfWanted, 240_000)
        return
      }
      if (frame.t === 'pairing.token') {
        cloud.token = frame.token
        state.cloud = { token: frame.token }
        saveState(config, state)
        cloud.authed = true
        log('bound to cloud user ' + frame.userId)
        refreshDownlinks()
        return
      }
      if (frame.t === 'auth.ok') {
        cloud.authed = true
        log('cloud authenticated as user ' + frame.userId)
        refreshDownlinks()
        return
      }
      if (frame.t === 'auth.fail') {
        log('cloud token rejected — restarting pairing')
        cloud.token = null
        state.cloud = undefined
        saveState(config, state)
        cloud.authed = false
        ws.close()
        return
      }
      if (frame.t === 'req') {
        proxy(frame).then((reply) => cloudSend(reply))
      }
    })
    ws.on('error', () => {})
    ws.on('close', () => {
      if (cloud.ws === ws) cloud.ws = null
      cloud.authed = false
      refreshDownlinks()
      if (cloud.disposed) return
      setTimeout(openCloud, 5000)
    })
  }

  if (cloudUrl !== null) openCloud()

  async function sessionsPayload() {
    const query = ctx.get ? ctx.get('sessionQuery') : undefined
    if (query === undefined) return { status: 503, body: { ok: false, error: 'sessionQuery unavailable' } }
    const records = await Promise.resolve(query.listSessions())
    const limited = (records ?? []).slice(0, 50)
    const titles = await Promise.allSettled(limited.map((record) => query.readTitleSnapshot(record.header.id)))
    const sessions = limited.map((record, index) => ({
      id: record.header.id,
      createdAt: record.header.createdAt,
      cwd: record.header.cwd ?? null,
      live: record.live,
      persisted: record.persisted,
      title: titles[index].status === 'fulfilled' ? (titles[index].value?.title?.title ?? null) : null,
    }))
    return { status: 200, body: { ok: true, sessions } }
  }

  async function surfacePayload(id, raw) {
    const query = ctx.get ? ctx.get('sessionQuery') : undefined
    if (query === undefined) return { status: 503, body: { ok: false, error: 'sessionQuery unavailable' } }
    const snapshot = await Promise.resolve(query.readSurface(id))
    if (raw) return { status: 200, body: { ok: true, count: (snapshot.events ?? []).length, events: (snapshot.events ?? []).slice(0, 4) } }
    return { status: 200, body: { ok: true, session: { id: snapshot.session.id, createdAt: snapshot.session.createdAt, cwd: snapshot.session.cwd ?? null }, messages: mapSurface(snapshot) } }
  }

  async function proxy(frame) {
    const urlPath = (frame.path ?? '').split('?')[0]
    try {
      if (urlPath === '/sessions') return { t: 'res', id: frame.id, ...(await sessionsPayload()) }
      if (urlPath.startsWith('/sessions/') && urlPath.endsWith('/surface')) {
        const id = decodeURIComponent(urlPath.slice('/sessions/'.length, -'/surface'.length))
        return { t: 'res', id: frame.id, ...(await surfacePayload(id, (frame.path ?? '').includes('?raw'))) }
      }

      const response = await fetch(`${localApi}${frame.path}`, {
        method: frame.method ?? 'GET',
        headers: { 'content-type': 'application/json' },
        body: frame.body === undefined ? undefined : JSON.stringify(frame.body),
      })
      const text = await response.text()
      let body = text
      try { body = JSON.parse(text) } catch { /* keep text */ }
      return { t: 'res', id: frame.id, status: response.status, body }
    } catch (error) {
      return { t: 'res', id: frame.id, status: 502, body: { error: `local api unreachable: ${String(error)}` } }
    }
  }

  const http = createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify(body))
    }
    const readBody = (onEnd) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => onEnd(raw))
    }
    if (req.method === 'GET' && req.url === '/health') return json(200, { ok: true, deviceId: state.deviceId })
    if (req.method === 'GET' && req.url === '/bindings') {
      const userId = req.headers['x-mock-user']
      if (!userId) return json(401, { ok: false, error: 'missing x-mock-user header' })
      const devices = state.binding === null || state.binding.userId !== userId ? [] : [{
        deviceId: state.deviceId,
        port: webPort,
        name: state.binding.name,
        online: true,
        info: { os: `${type()} ${release()}`, platform: platform(), host: hostname() },
      }]
      return json(200, { ok: true, devices })
    }
    if (req.method === 'POST' && req.url === '/pair/claim') {
      return readBody((raw) => {
        const userId = req.headers['x-mock-user']
        if (!userId) return json(401, { ok: false, error: 'missing x-mock-user header' })
        let code
        try { code = JSON.parse(raw).code } catch { return json(400, { ok: false, error: 'bad json' }) }
        if (pairing === null) return json(404, { ok: false, error: 'unknown-code' })
        pairing.attempts += 1
        if (Date.now() > pairing.expiresAt) { pairing = null; return json(410, { ok: false, error: 'expired' }) }
        if (pairing.attempts > 3) { pairing = null; return json(429, { ok: false, error: 'too-many-attempts' }) }
        if (code !== pairing.code) return json(404, { ok: false, error: 'unknown-code' })
        pairing = null
        state.binding = { userId, name: `${hostname()} (dsh)` }
        saveState(config, state)
        log(`bound to user ${userId}`)
        return json(200, { ok: true, deviceId: state.deviceId, port: webPort })
      })
    }
    if (req.method === 'POST' && (req.url === '/devices/rename' || req.url === '/devices/unbind')) {
      return readBody((raw) => {
        const userId = req.headers['x-mock-user']
        if (!userId) return json(401, { ok: false, error: 'missing x-mock-user header' })
        let body
        try { body = JSON.parse(raw) } catch { return json(400, { ok: false, error: 'bad json' }) }
        if (state.binding === null) return json(404, { ok: false, error: 'unknown-endpoint' })
        if (state.binding.userId !== userId) return json(403, { ok: false, error: 'not-your-device' })
        if (req.url === '/devices/rename') {
          if (typeof body.name !== 'string' || body.name.length === 0 || body.name.length > 24) return json(400, { ok: false, error: 'bad-name' })
          state.binding.name = body.name
          saveState(config, state)
          log(`renamed to ${body.name}`)
          return json(200, { ok: true })
        }
        state.binding = null
        saveState(config, state)
        issuePairingCode()
        return json(200, { ok: true })
      })
    }
    const urlPath = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && urlPath === '/sessions') {
      sessionsPayload().then((out) => json(out.status, out.body)).catch((error) => json(500, { ok: false, error: String(error?.message ?? error) }))
      return
    }
    if (req.method === 'GET' && urlPath.startsWith('/sessions/') && urlPath.endsWith('/surface')) {
      const id = decodeURIComponent(urlPath.slice('/sessions/'.length, -'/surface'.length))
      surfacePayload(id, (req.url ?? '').includes('?raw')).then((out) => json(out.status, out.body)).catch((error) => json(500, { ok: false, error: String(error?.message ?? error) }))
      return
    }
    return json(404, { ok: false, error: 'not found' })
  })

  const wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname !== '/client') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url))
  })

  wss.on('connection', (ws, url) => {
    const userId = url.searchParams.get('user')
    if (userId === null || state.binding === null || state.binding.userId !== userId) {
      ws.close(4003, 'not bound to this user')
      return
    }
    log(`client attached: user ${userId}`)
    clientSocket = ws
    refreshDownlinks()
    ws.on('message', async (data) => {
      let frame
      try { frame = JSON.parse(String(data)) } catch { return send(ws, { t: 'error', error: 'bad json' }) }
      if (frame.t !== 'req' || typeof frame.id !== 'string') return send(ws, { t: 'error', error: 'expected req frame' })
      const reply = await proxy(frame)
      send(ws, reply)
    })
    ws.on('close', () => {
      if (clientSocket === ws) {
        clientSocket = null
        refreshDownlinks()
      }
      log('client detached')
    })
  })

  http.on('error', (error) => {
    log(`FAILED to listen on ${host}:${String(port)} (${String(error.message)}); relay-lan stays idle — free the port or change the port config and restart`)
    try { http.close() } catch { /* already closed */ }
  })
  http.listen(port, host, () => {
    log(`listening on ${host}:${String(port)}; proxying to ${localApi}`)
  })

  ctx.on('dispose', () => {
    downlinks.disposed = true
    closeDownlinks()
    cloud.disposed = true
    if (cloud.reissueTimer !== null) clearTimeout(cloud.reissueTimer)
    if (cloud.ws !== null) cloud.ws.close()
    for (const ws of wss.clients) ws.close()
    http.close()
  })
}
