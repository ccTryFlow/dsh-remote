const api = require('../../utils/api')
const { createRelaySocket } = require('../../utils/socket')
const { call } = require('../../utils/rpc')

const SETTINGS = [
  { key: 'workspace', label: '工作区配置', gated: true },
  { key: 'credentials', label: '凭据管理', gated: true },
  { key: 'about', label: '关于 DeepSeek Harness', gated: false, url: 'https://www.deepseek.com/harness/' },
]

Page({
  data: {
    user: '',
    devices: 0,
    online: 0,
    chats: 0,
    settings: SETTINGS,
    presets: [],
    presetHint: '加载中…',
    selected: '',
  },

  onLoad() {
    this.presetSocket = null
    this.presetLoading = false
  },

  onShow() {
    this.setData({ user: api.getUser() })
    api.getDevices()
      .then((res) => {
        const devices = res.devices ?? []
        this.setData({ devices: devices.length, online: devices.filter((d) => d.online).length })
      })
      .catch(() => {})
    api.getSessions()
      .then((res) => this.setData({ chats: (res.sessions ?? []).length }))
      .catch(() => {})
    this.loadPresets()
  },

  onUnload() {
    this.closePresetSocket()
  },

  closePresetSocket() {
    if (this.presetSocket) {
      this.presetSocket.onclose = null
      this.presetSocket.close()
      this.presetSocket = null
    }
  },

  loadPresets() {
    if (this.presetLoading) return
    const device = wx.getStorageSync('lastDeviceV1')
    if (!device || !device.deviceId) {
      this.setData({ presets: [], presetHint: '连接设备后可选择' })
      return
    }
    this.presetLoading = true
    this.closePresetSocket()
    const socket = createRelaySocket(device.deviceId, device.port)
    this.presetSocket = socket
    socket.onclose = () => {
      if (this.presetSocket === socket) this.presetSocket = null
      if (this.presetLoading && this.data.presets.length === 0) {
        this.presetLoading = false
        this.setData({ presetHint: '设备连接失败' })
      }
    }
    call(socket, 'agentPreset.list', {})
      .then((result) => {
        if (result.ok !== true) throw new Error(result.error?.message ?? 'agentPreset.list failed')
        const presets = (result.value.presets ?? [])
          .filter((p) => !p.broken)
          .map((p) => ({ id: p.id, label: p.name ?? p.id, isDefault: !!p.isDefault }))
        const stored = wx.getStorageSync('agentPresetV1')
        const selected = presets.some((p) => p.id === stored)
          ? stored
          : (presets.find((p) => p.isDefault) ?? { id: '' }).id
        this.setData({ presets, selected, presetHint: presets.length === 0 ? '设备没有可用预设' : '' })
      })
      .catch(() => {
        if (this.data.presets.length === 0) this.setData({ presetHint: '获取失败,稍后再试' })
      })
      .then(() => {
        this.presetLoading = false
        if (this.presetSocket === socket) this.closePresetSocket()
      })
  },

  tapPreset(e) {
    const id = e.currentTarget.dataset.id
    if (!id || id === this.data.selected) return
    wx.setStorageSync('agentPresetV1', id)
    this.setData({ selected: id })
    wx.showToast({ title: '已选择,新会话生效', icon: 'none' })
  },

  tapSetting(e) {
    const { key, gated, url } = e.currentTarget.dataset
    if (gated) {
      wx.showToast({ title: '该入口仅限电脑本机使用', icon: 'none' })
      return
    }
    if (url) {
      wx.navigateTo({
        url: `/pages/webview/index?src=${encodeURIComponent(url)}&title=${encodeURIComponent('关于 DeepSeek Harness')}`,
        fail: () => {
          wx.setClipboardData({ data: url, success: () => wx.showToast({ title: '链接已复制,请在浏览器打开', icon: 'none' }) })
        },
      })
      return
    }
    wx.showToast({ title: `${key} · 即将上线`, icon: 'none' })
  },
})
