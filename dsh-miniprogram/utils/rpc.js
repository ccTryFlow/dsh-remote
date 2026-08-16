function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16)
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function envelope(method, payload) {
  return { type: 'client-request', rpcId: uuid(), method, payload }
}

/** Call one harness /api RPC through the relay socket; resolves the RpcResult body. */
function call(socket, method, payload) {
  return socket.request('POST', '/api/' + method, envelope(method, payload)).then((frame) => {
    if (frame.status !== 200) throw new Error('HTTP ' + frame.status)
    const body = frame.body
    if (body === undefined || body.result === undefined) throw new Error('bad rpc response')
    return body.result
  })
}

function respond(socket, rpcId, result) {
  return socket.request('POST', '/api/respond', { type: 'client-response', rpcId, result }).then((frame) => {
    if (frame.status !== 200) throw new Error('HTTP ' + frame.status)
    return frame.body
  })
}

module.exports = { call, respond }
