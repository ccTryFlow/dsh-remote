const { RELAY_BASE, USER_KEY } = require('./config')

function getUser() {
  let user = wx.getStorageSync(USER_KEY)
  if (!user) {
    user = 'mock-' + Math.random().toString(36).slice(2, 12)
    wx.setStorageSync(USER_KEY, user)
  }
  return user
}

function request(method, path, data, device) {
  return new Promise((resolve, reject) => {
    const header = { 'content-type': 'application/json', 'x-mock-user': getUser() }
    if (device !== undefined) header['x-mock-device'] = device
    wx.request({
      url: RELAY_BASE + path,
      method,
      data,
      header,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data)
        else reject(Object.assign(new Error(res.data?.error ?? 'HTTP ' + res.statusCode), { code: res.statusCode, body: res.data }))
      },
      fail(err) { reject(Object.assign(new Error(err.errMsg ?? 'network error'), { code: 0 })) },
    })
  })
}

module.exports = {
  getUser,
  getDevices: () => request('GET', '/bindings'),
  claim: (code) => request('POST', '/pair/claim', { code }),
  renameDevice: (deviceId, port, name) => request('POST', '/devices/rename', { deviceId, port, name }),
  unbindDevice: (deviceId, port) => request('POST', '/devices/unbind', { deviceId, port }),
  getSessions: (device) => request('GET', '/sessions', undefined, device),
  getSessionSurface: (id, device) => request('GET', '/sessions/' + encodeURIComponent(id) + '/surface', undefined, device),
}
