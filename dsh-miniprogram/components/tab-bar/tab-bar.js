Component({
  properties: {
    active: { type: String, value: 'devices' },
  },
  methods: {
    go(e) {
      const tab = e.currentTarget.dataset.tab
      if (tab === this.data.active) return
      wx.redirectTo({ url: tab === 'devices' ? '/pages/devices/index' : '/pages/profile/index' })
    },
  },
})
