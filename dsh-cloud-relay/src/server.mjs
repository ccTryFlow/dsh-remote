import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomBytes, randomInt } from 'node:crypto'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.RELAY_PORT ?? 4020)
const STATE_FILE = process.env.RELAY_STATE ?? join(homedir(), '.dsh', 'cloud-relay.json')
const CODE_TTL_MS = 5 * 60_000
const DEVICE_TIMEOUT_MS = 15_000
const CODE_ALPHABET = '0123456789'

const log = (...a) => console.log('[cloud-relay]', ...a)
const endpointKey = (deviceId, port) => `${deviceId}:${port}`
const send = (ws, frame) => { if (ws.readyState === 1) ws.send(JSON.stringify(frame)) }

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
function saveState() {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  const durable = {}
  for (const [key, b] of bindings) durable[key] = { users: [...b.users], token: b.token, name: b.name, info: b.info }
  writeFileSync(STATE_FILE, JSON.stringify({ bindings: durable }, null, 2))
}

const bindings = new Map() // key -> { users:Set<userId>, token, deviceWs, clients:Set<ws>, name, info }
for (const [key, b] of Object.entries(loadState().bindings ?? {})) {
  const users = new Set(b.users ?? (b.userId !== undefined ? [b.userId] : []))
  bindings.set(key, { deviceWs: null, clients: new Set(), ...b, users })
}
const claimBuckets = new Map() // ip -> { count, resetAt }: missed pairing guesses per IP

function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff !== '') return xff.split(',')[0].trim()
  return req.socket.remoteAddress ?? '?'
}

function claimBucket(ip) {
  const now = Date.now()
  let b = claimBuckets.get(ip)
  if (b === undefined || now > b.resetAt) {
    b = { count: 0, resetAt: now + 10 * 60_000 }
    claimBuckets.set(ip, b)
    if (claimBuckets.size > 10_000) for (const [k, v] of claimBuckets) if (now > v.resetAt) claimBuckets.delete(k)
  }
  return b
}

const pairings = new Map() // code -> { deviceWs, deviceId, port, name, info, expiresAt, attempts }
const pendingClientFrames = new Map() // frameId -> clientWs (phone req -> device)
const pendingHttpFrames = new Map() // frameId -> { resolve, reject, timer } (cloud http -> device)
const deviceSocketAuth = new Map() // device ws -> endpoint key (set by auth OR by claim)
let httpSeq = 0

function mintCode() {
  let code = ''
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

function sweepPairings() {
  const now = Date.now()
  for (const [code, s] of pairings) {
    if (now > s.expiresAt || s.deviceWs.readyState > 1) pairings.delete(code)
  }
}

function listDevicesForUser(userId) {
  return [...bindings.entries()]
    .filter(([, b]) => b.users.has(userId))
    .map(([key, b]) => ({
      deviceId: key.split(':')[0],
      port: Number(key.split(':')[1]),
      name: b.name,
      online: b.deviceWs !== null && b.deviceWs.readyState === 1,
      info: b.info ?? {},
    }))
}

/** Resolve which device a user-scoped HTTP request targets: explicit header or first bound device. */
function deviceForUser(userId, header) {
  if (header !== undefined) {
    const b = bindings.get(header)
    if (b !== undefined && b.users.has(userId)) return [header, b]
    return [undefined, undefined]
  }
  for (const [key, b] of bindings) if (b.users.has(userId)) return [key, b]
  return [undefined, undefined]
}

/** Forward one HTTP-shaped request to the device uplink and await its res frame. */
function deviceRequest(key, binding, method, path, query = '') {
  if (binding.deviceWs === null || binding.deviceWs.readyState !== 1) {
    return Promise.resolve({ status: 503, body: { ok: false, error: 'device offline' } })
  }
  const id = `hr-${++httpSeq}-${Date.now()}`
  return new Promise((resolve) => {
    pendingHttpFrames.set(id, { resolve, timer: setTimeout(() => {
      pendingHttpFrames.delete(id)
      resolve({ status: 504, body: { ok: false, error: 'device timeout' } })
    }, DEVICE_TIMEOUT_MS) })
    send(binding.deviceWs, { t: 'req', id, method, path: path + query })
  })
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => resolve(raw))
  })
}

const http = createServer(async (req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify(body))
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const userId = req.headers['x-mock-user']
  if (url.pathname === '/health') return json(200, { ok: true, port: PORT })
  if (url.pathname === '/bindings') {
    if (!userId) return json(401, { ok: false, error: 'missing x-mock-user header' })
    return json(200, { ok: true, devices: listDevicesForUser(userId) })
  }
  if (url.pathname === '/pair/claim' && req.method === 'POST') {
    const raw = await readBody(req)
    if (!userId) return json(401, { ok: false, error: 'missing x-mock-user header' })
    let code
    try { code = JSON.parse(raw).code } catch { return json(400, { ok: false, error: 'bad json' }) }
    sweepPairings()
    const ip = clientIp(req)
    const bucket = claimBucket(ip)
    if (bucket.count >= 20) return json(429, { ok: false, error: 'ip-rate-limited', retryInMs: bucket.resetAt - Date.now() })
    const session = pairings.get(code)
    if (session === undefined) { bucket.count += 1; return json(404, { ok: false, error: 'unknown-code' }) }
    session.attempts += 1
    if (Date.now() > session.expiresAt) { pairings.delete(code); bucket.count += 1; return json(410, { ok: false, error: 'expired' }) }
    if (session.attempts > 3) { pairings.delete(code); bucket.count += 1; return json(429, { ok: false, error: 'too-many-attempts' }) }
    const key = endpointKey(session.deviceId, session.port)
    const existing = bindings.get(key)
    pairings.delete(code)
    if (existing !== undefined) {
      if (existing.deviceWs !== null && existing.deviceWs !== session.deviceWs) existing.deviceWs.close()
      if (existing.deviceWs !== session.deviceWs) {
        existing.deviceWs = session.deviceWs
        deviceSocketAuth.set(session.deviceWs, key)
      }
      const isNew = !existing.users.has(userId)
      existing.users.add(userId)
      saveState()
      send(session.deviceWs, { t: 'pairing.token', token: existing.token, userId })
      log(isNew ? `user ${userId} added to ${key}` : `user ${userId} re-claimed ${key}`)
      return json(200, { ok: true, deviceId: session.deviceId, port: session.port })
    }
    const token = randomBytes(32).toString('hex')
    bindings.set(key, { users: new Set([userId]), token, name: session.name, info: session.info ?? {}, deviceWs: session.deviceWs, clients: new Set() })
    deviceSocketAuth.set(session.deviceWs, key)
    saveState()
    send(session.deviceWs, { t: 'pairing.token', token, userId })
    log(`bound ${key} -> user ${userId}`)
    return json(200, { ok: true, deviceId: session.deviceId, port: session.port })
  }
  if ((url.pathname === '/devices/rename' || url.pathname === '/devices/unbind') && req.method === 'POST') {
    const raw = await readBody(req)
    if (!userId) return json(401, { ok: false, error: 'missing x-mock-user header' })
    let body
    try { body = JSON.parse(raw) } catch { return json(400, { ok: false, error: 'bad json' }) }
    const key = endpointKey(String(body.deviceId ?? ''), Number(body.port ?? 0))
    const binding = bindings.get(key)
    if (binding === undefined) return json(404, { ok: false, error: 'unknown-endpoint' })
    if (!binding.users.has(userId)) return json(403, { ok: false, error: 'not-your-device' })
    if (url.pathname === '/devices/rename') {
      if (typeof body.name !== 'string' || body.name.length === 0 || body.name.length > 24) return json(400, { ok: false, error: 'bad-name' })
      binding.name = body.name
      saveState()
      log(`renamed -> ${body.name}`)
      return json(200, { ok: true })
    }
    binding.users.delete(userId)
    for (const c of binding.clients) c.close()
    binding.clients.clear()
    if (binding.users.size === 0) {
      if (binding.deviceWs !== null) binding.deviceWs.close()
      bindings.delete(key)
      log('unbound ' + key)
    } else {
      log(`user ${userId} detached from ${key} (${binding.users.size} left)`)
    }
    saveState()
    return json(200, { ok: true })
  }
  if (userId !== undefined && req.method === 'GET'
    && (url.pathname === '/sessions' || (url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/surface')))) {
    const [key, binding] = deviceForUser(userId, req.headers['x-mock-device'])
    if (key === undefined) return json(404, { ok: false, error: 'no bound device' })
    const out = await deviceRequest(key, binding, 'GET', url.pathname, url.search)
    return json(out.status, out.body)
  }
  return json(404, { ok: false, error: 'not found' })
})

const wss = new WebSocketServer({ noServer: true })
http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== '/device' && url.pathname !== '/client') return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url))
})

wss.on('connection', (ws, url) => (url.pathname === '/device' ? handleDevice(ws) : handleClient(ws, url)))

function handleDevice(ws) {
  const authKey = () => deviceSocketAuth.get(ws) ?? null
  ws.on('message', async (data) => {
    let frame
    try { frame = JSON.parse(String(data)) } catch { return send(ws, { t: 'error', error: 'bad json' }) }
    if (frame.t === 'pairing.start') {
      sweepPairings()
      if (pairings.size >= 50) return send(ws, { t: 'error', error: 'too many pairings' })
      if (typeof frame.deviceId !== 'string' || typeof frame.port !== 'number' || typeof frame.name !== 'string') {
        return send(ws, { t: 'error', error: 'bad pairing.start' })
      }
      for (const [c, s] of pairings) if (s.deviceWs === ws) pairings.delete(c)
      const code = mintCode()
      pairings.set(code, { deviceWs: ws, deviceId: frame.deviceId, port: frame.port, name: frame.name, info: frame.info ?? {}, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 })
      log(`pairing session ${code} for ${endpointKey(frame.deviceId, frame.port)} (${frame.name})`)
      return send(ws, { t: 'pairing.code', code, expiresAt: Date.now() + CODE_TTL_MS })
    }
    if (frame.t === 'auth') {
      const entry = [...bindings.entries()].find(([, b]) => b.token === frame.token)
      if (entry === undefined) return send(ws, { t: 'auth.fail', error: 'unknown-token' })
      const [key, binding] = entry
      if (binding.deviceWs !== null && binding.deviceWs !== ws) binding.deviceWs.close()
      binding.deviceWs = ws
      deviceSocketAuth.set(ws, key)
      log(`device online: ${key} (users ${[...binding.users].join(', ')})`)
      return send(ws, { t: 'auth.ok', deviceId: key.split(':')[0], userId: [...binding.users][0], users: [...binding.users] })
    }
    if (frame.t === 'req') return // phone/cloud requests are outbound to the device; the device never sends req
    if (frame.t === 'res') {
      const httpWaiter = pendingHttpFrames.get(frame.id)
      if (httpWaiter !== undefined) {
        clearTimeout(httpWaiter.timer)
        pendingHttpFrames.delete(frame.id)
        httpWaiter.resolve({ status: frame.status ?? 502, body: frame.body })
        return
      }
      const clientWs = pendingClientFrames.get(frame.id)
      if (clientWs === undefined) return
      pendingClientFrames.delete(frame.id)
      return send(clientWs, frame)
    }
    if (frame.t === 'ev') {
      const binding = bindings.get(authKey())
      if (binding !== undefined) for (const client of binding.clients) send(client, frame)
      return
    }
    return send(ws, { t: 'error', error: 'unknown frame' })
  })
  ws.on('close', () => {
    const key = authKey()
    deviceSocketAuth.delete(ws)
    if (key !== null) {
      const binding = bindings.get(key)
      if (binding !== undefined && binding.deviceWs === ws) {
        binding.deviceWs = null
        log(`device offline: ${key} (binding kept)`)
      }
    }
    for (const [code, s] of pairings) if (s.deviceWs === ws) pairings.delete(code)
  })
}

function handleClient(ws, url) {
  const userId = url.searchParams.get('user')
  const deviceId = url.searchParams.get('deviceId')
  const port = Number(url.searchParams.get('port'))
  if (userId === null || deviceId === null) return ws.close(4001, 'missing user or deviceId')
  const binding = bindings.get(endpointKey(deviceId, port))
  if (binding === undefined || !binding.users.has(userId)) return ws.close(4003, 'not bound to this user')
  binding.clients.add(ws)
  log(`client attached: user ${userId} -> ${endpointKey(deviceId, port)}`)
  ws.on('message', (data) => {
    let frame
    try { frame = JSON.parse(String(data)) } catch { return send(ws, { t: 'error', error: 'bad json' }) }
    if (frame.t !== 'req' || typeof frame.id !== 'string') return send(ws, { t: 'error', error: 'expected req frame' })
    if (binding.deviceWs === null || binding.deviceWs.readyState !== 1) {
      return send(ws, { t: 'res', id: frame.id, status: 503, body: { error: 'device offline' } })
    }
    pendingClientFrames.set(frame.id, ws)
    send(binding.deviceWs, frame)
  })
  ws.on('close', () => binding.clients.delete(ws))
}

setInterval(() => {
  for (const ws of wss.clients) if (ws.readyState === 1) ws.ping()
}, 30_000)
setInterval(sweepPairings, 60_000)

http.listen(PORT, () => log(`listening on :${PORT} (device WS /device, client WS /client); state ${STATE_FILE}`))
