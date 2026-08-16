const api = require('../../utils/api')

Page({
  data: {
    deviceId: '',
    port: 0,
    name: '',
    paired: false,
    time: '',
    saving: false,
  },

  onLoad(query) {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    this.setData({
      deviceId: query.deviceId ?? '',
      port: Number(query.port ?? 0),
      paired: query.paired === '1',
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    })
  },

  onInput(e) {
    this.setData({ name: e.detail.value })
  },

  save() {
    if (this.data.saving) return
    const name = this.data.name.trim()
    if (name.length === 0) {
      wx.showToast({ title: '请输入设备名称', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    api.renameDevice(this.data.deviceId, this.data.port, name)
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'success' })
        setTimeout(() => wx.reLaunch({ url: '/pages/devices/index' }), 600)
      })
      .catch((err) => {
        this.setData({ saving: false })
        wx.showToast({ title: `保存失败: ${err.message}`, icon: 'none' })
      })
  },

  skip() {
    wx.reLaunch({ url: '/pages/devices/index' })
  },
})
