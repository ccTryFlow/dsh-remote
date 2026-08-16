import WebSocket from 'ws'

const HTTP = 'http://127.0.0.1:4020'
const WS = 'ws://127.0.0.1:4020'

const http = async (path, user, body) => {
  const r = await fetch(HTTP + path, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(user ? { 'x-mock-user': user } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, body: await r.json() }
}

const nextFrame = (ws, pred) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('frame timeout')), 5000)
  const on = (data) => {
    const f = JSON.parse(String(data))
    if (!pred(f)) return
    clearTimeout(timer); ws.off('message', on); resolve(f)
  }
  ws.on('message', on)
})

const open = (ws) => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
const closed = (ws) => new Promise((res) => ws.on('close', res))

let failures = 0
const check = (name, cond) => {
  console.log(cond ? `PASS ${name}` : `FAIL ${name}`)
  if (!cond) failures++
}

// migration check: old-format state seeds user "legacy"
const dev = new WebSocket(WS + '/device')
await open(dev)
dev.send(JSON.stringify({ t: 'pairing.start', deviceId: 'dev1', port: 3080, name: 't', info: {} }))
const tokenFrame = nextFrame(dev, (f) => f.t === 'pairing.token')
const code1 = (await nextFrame(dev, (f) => f.t === 'pairing.code')).code
const c1 = await http('/pair/claim', 'userA', { code: code1 })
check('userA claims code', c1.status === 200 && c1.body.ok === true)
const token = (await tokenFrame).token

const dev2 = new WebSocket(WS + '/device')
await open(dev2)
const authOk = nextFrame(dev2, (f) => f.t === 'auth.ok')
dev2.send(JSON.stringify({ t: 'auth', token }))
const okFrame = await authOk
check('token auth works', Array.isArray(okFrame.users) && okFrame.users.includes('userA'))

// re-issue pairing while authed (new plugin behavior) -> userB joins
dev2.send(JSON.stringify({ t: 'pairing.start', deviceId: 'dev1', port: 3080, name: 't', info: {} }))
const code2 = (await nextFrame(dev2, (f) => f.t === 'pairing.code')).code
const c2 = await http('/pair/claim', 'userB', { code: code2 })
check('userB joins bound device', c2.status === 200 && c2.body.ok === true)

const bB = await http('/bindings', 'userB')
check('userB sees device', bB.body.devices?.length === 1 && bB.body.devices[0].online === true)
const bA = await http('/bindings', 'userA')
check('userA still sees device', bA.body.devices?.length === 1)

const clA = new WebSocket(WS + '/client?user=userA&deviceId=dev1&port=3080')
await open(clA)
const clB = new WebSocket(WS + '/client?user=userB&deviceId=dev1&port=3080')
await open(clB)
check('both users attach as clients', true)

const clC = new WebSocket(WS + '/client?user=userC&deviceId=dev1&port=3080')
const clCClose = closed(clC)
check('userC rejected', (await clCClose) === 4003)

const u1 = await http('/devices/unbind', 'userB', { deviceId: 'dev1', port: 3080 })
check('userB unbind', u1.status === 200)
const bB2 = await http('/bindings', 'userB')
check('userB no longer sees device', bB2.body.devices?.length === 0)
const bA2 = await http('/bindings', 'userA')
check('userA unaffected by userB unbind', bA2.body.devices?.length === 1)

const u2 = await http('/devices/unbind', 'userA', { deviceId: 'dev1', port: 3080 })
check('userA unbind', u2.status === 200)
const dev2Closed = closed(dev2)
check('device socket closed after last unbind', (await dev2Closed) !== undefined)

const bA3 = await http('/bindings', 'userA')
check('no devices remain', bA3.body.devices?.length === 0)

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
