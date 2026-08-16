const api = require('../../utils/api')

const ERROR_TEXT = {
  'unknown-code': '配对码无效',
  expired: '配对码已过期',
  'too-many-attempts': '尝试次数过多，请重新获取',
  'endpoint-bound': '设备已绑定其他用户',
}

Page({
  data: {
    mode: 'code',
    digits: ['', '', '', '', '', ''],
    codeValue: '',
    codeFocus: true,
    focusIndex: 0,
    submitting: false,
  },

  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode })
  },

  onCodeInput(e) {
    const value = String(e.detail.value || '').replace(/\D/g, '').slice(0, 6)
    const digits = value.split('')
    while (digits.length < 6) digits.push('')
    const prev = this.data.codeValue
    this.setData({ codeValue: value, digits, focusIndex: Math.min(value.length, 5) })
    if (prev.length < 6 && value.length === 6 && !this.data.submitting) this.connect()
  },

  clearCode() {
    const digits = ['', '', '', '', '', '']
    this.setData({ codeValue: '', digits, focusIndex: 0, codeFocus: false })
    this.setData({ codeFocus: true })
  },

  code() {
    return this.data.codeValue
  },

  connect() {
    if (this.data.submitting) return
    const code = this.code()
    if (code.length !== 6) {
      wx.showToast({ title: '请输入完整 6 位配对码', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    api.claim(code)
      .then((res) => {
        wx.showToast({ title: '配对成功', icon: 'success' })
        setTimeout(() => {
          wx.redirectTo({
            url: `/pages/rename/index?deviceId=${res.deviceId}&port=${res.port}&paired=1`,
          })
        }, 600)
      })
      .catch((err) => {
        this.setData({ submitting: false })
        wx.showToast({ title: ERROR_TEXT[err.message] ?? `连接失败: ${err.message}`, icon: 'none' })
      })
  },

  scan() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: (res) => {
        const text = res.result.trim()
        const code = text.replace(/\D/g, '').slice(0, 6)
        if (code.length !== 6) {
          wx.showToast({ title: '二维码内容不是配对码', icon: 'none' })
          return
        }
        const digits = code.split('')
        while (digits.length < 6) digits.push('')
        this.setData({ digits, codeValue: code, mode: 'code' })
        this.connect()
      },
      fail: () => {},
    })
  },
})
