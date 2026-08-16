const api = require('../../utils/api')

Page({
  data: {
    devices: [],
    loading: true,
    menuOpen: false,
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    this.setData({ loading: true })
    api.getDevices()
      .then((res) => this.setData({ devices: this.decorate(res.devices ?? []), loading: false }))
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: err.code === 0 ? '中继不可达' : '加载失败', icon: 'none' })
      })
  },

  decorate(devices) {
    return devices.map((d) => ({
      ...d,
      sub: [d.info?.host, d.info?.platform].filter(Boolean).join(' · ') || d.deviceId.slice(0, 8),
      os: d.info?.os ?? '',
    }))
  },

  openMenu() {
    this.setData({ menuOpen: true })
  },

  closeMenu() {
    this.setData({ menuOpen: false })
  },

  goConnect() {
    wx.navigateTo({ url: '/pages/connect/index' })
  },

  openChat(e) {
    const { id, port, name } = e.currentTarget.dataset
    wx.navigateTo({ url: `/pages/chat/index?deviceId=${id}&port=${port}&name=${encodeURIComponent(name)}` })
  },

  rowAction(e) {
    const { id, port, name } = e.currentTarget.dataset
    wx.showActionSheet({
      itemList: ['重命名', '解绑设备'],
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: `/pages/rename/index?deviceId=${id}&port=${port}&name=${encodeURIComponent(name)}` })
        } else if (res.tapIndex === 1) {
          api.unbindDevice(id, port)
            .then(() => { wx.showToast({ title: '已解绑', icon: 'success' }); this.refresh() })
            .catch((err) => wx.showToast({ title: err.message, icon: 'none' }))
        }
      },
    })
  },
})
