const { createRelaySocket } = require('../../utils/socket')
const api = require('../../utils/api')
const { call, respond } = require('../../utils/rpc')
const { mdBlocks } = require('../../utils/md')

const PERMISSIONS = [
  { id: 'read-only', label: '只读' },
  { id: 'workspace-write', label: '工作区' },
  { id: 'danger-full-access', label: '完全' },
]

const COMMANDS = [
  { token: '/compact', desc: '压缩较早的对话历史,释放上下文' },
  { token: '/export', desc: '下载本会话日志为 ZIP' },
  { token: '/feedback', desc: '记录关于本会话的反馈' },
  { token: '/goal', desc: '设置或查看长任务目标' },
  { token: '/permission', desc: '切换权限预设 · 沙箱模式 + 审批策略' },
  { token: '/plan', desc: '进入或退出计划模式' },
  { token: '/model', desc: '选择本会话使用的模型' },
]

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const fmtClock = (t) => {
  const d = new Date(t)
  const now = new Date()
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? hm : (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm
}

const fmtSec = (ms) => {
  const s = ms / 1000
  return (s >= 10 ? Math.round(s) : Math.round(s * 10) / 10) + '秒'
}

const fmtMetrics = (m) => {
  if (m === null || m === undefined) return ''
  const parts = []
  if (typeof m.time === 'number') {
    const d = new Date(m.time)
    parts.push(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'))
  }
  if (m.runMs !== null && m.runMs !== undefined) parts.push('用时 ' + fmtSec(m.runMs))
  if (m.ttftMs !== null && m.ttftMs !== undefined) parts.push('首 token ' + fmtSec(m.ttftMs))
  if (m.tps !== null && m.tps !== undefined) parts.push(m.tps + ' tok/s')
  return parts.join(' · ')
}

Page({
  data: {
    name: '',
    deviceId: '',
    port: 0,
    messages: [],
    anchor: '',
    input: '',
    sending: false,
    activeSessionId: null,
    sheetOpen: false,
    commands: COMMANDS,
    drawerOpen: false,
    navOpen: false,
    navItems: [],
    sessions: [],
    folders: [],
    ungrouped: [],
    foldOpen: {},
    dialog: { open: false, value: '' },
    currentTitle: '',
    ungroupedOpen: false,
    sessionsLoading: false,
    modelSheetOpen: false,
    models: [],
    modelsLoading: false,
    effortSheetOpen: false,
    efforts: [],
    permissions: PERMISSIONS,
    permission: 'workspace-write',
    model: '',
    modelLabel: '模型',
    provider: '',
    effort: '',
    effortLabel: '推理',
    lastId: 0,
    lastAgentId: 0,
    msgMenu: { open: false, id: 0, top: 0, left: 0, arrowLeft: 0, above: true },
    scrollTop: 0,
    selectingId: 0,
  },

  onLoad(query) {
    const name = decodeURIComponent(query.name ?? '设备')
    this.setData({
      deviceId: query.deviceId ?? '',
      port: Number(query.port ?? 0),
      name,
      messages: [{ id: this.nextId(), kind: 'divider', text: name }],
    })
    wx.setNavigationBarTitle({ title: name })
    wx.setStorageSync('lastDeviceV1', { deviceId: query.deviceId ?? '', port: Number(query.port ?? 0) })
    this.openSocket = () => {
      if (this.destroyed) return
      if (this.socket) { this.socket.onclose = null; this.socket.close() }
      this.socket = createRelaySocket(this.data.deviceId, this.data.port)
      this.socket.onEvent = (frame) => this.onRelayEvent(frame)
      this.socket.onclose = () => {
        if (this.destroyed) return
        this.reconnectTimer = setTimeout(this.openSocket, 1000)
      }
      this.socket.onready = () => this.recoverTurn()
    }
    this.openSocket()
    this.pendingPermission = null
    this.pendingModel = null
    this.turn = null
    this.stream = null
    this.appending = null
    this.pinned = true
    this.lastTop = 0
    this.settledAsks = new Set()
    this.todoMsgId = null
    this.socket.onEvent = (frame) => this.onRelayEvent(frame)
  },

  onShow() {
    if (this.destroyed) return
    const app = getApp()
    if (app.hiddenAt === undefined) return
    const away = Date.now() - app.hiddenAt
    app.hiddenAt = undefined
    if (away > 4000) {
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
      this.openSocket()
    }
  },

  onUnload() {
    this.destroyed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.resetTurn()
    if (this.socket) { this.socket.onclose = null; this.socket.close() }
  },

  nextId() {
    this.setData({ lastId: this.data.lastId + 1 })
    return this.data.lastId
  },

  push(message) {
    const messages = this.data.messages.concat({ id: this.nextId(), ...message })
    this.setData({ messages })
    this.syncLastAgent()
    if (this.pinned) this.stickBottom()
  },

  syncLastAgent() {
    const msgs = this.data.messages
    let id = 0
    for (let k = msgs.length - 1; k >= 0; k--) {
      const m = msgs[k]
      if (m.kind === 'agent' && m.blocks && m.blocks.length > 0 && !m.streaming) { id = m.id; break }
    }
    if (id !== this.data.lastAgentId) this.setData({ lastAgentId: id })
  },

  stickBottom() {
    this.bottomTick = this.bottomTick === true
    this.setData({ scrollTop: this.bottomTick ? 9999999 : 9999998 })
  },

  onMsgScroll(e) {
    const top = e.detail.scrollTop
    if (top < this.lastTop - 30) this.pinned = false
    this.lastTop = top
  },

  onMsgBottom() {
    this.pinned = true
  },

  dropTyping() {
    this.setData({ messages: this.data.messages.filter((m) => m.kind !== 'typing') })
  },

  deviceHeader() {
    return this.data.deviceId + ':' + this.data.port
  },

  maxSeq() {
    return this.data.messages.reduce((max, m) => Math.max(max, m.seq ?? 0), 0)
  },

  pushAgent(m) {
    if (m.kind === 'tool') {
      this.push({ kind: 'agent', html: '', text: '', reasoning: null, tokens: null, thinkingOpen: false, traces: [{ tool: m.name, summary: '', dur: '' }], seq: m.seq, foot: '' })
    } else {
      this.push({ kind: 'agent', blocks: mdBlocks(m.text), text: m.text, reasoning: m.reasoning, tokens: m.tokens, out: (m.metrics && m.metrics.out) || null, thinkingOpen: true, traces: [], seq: m.seq, foot: fmtMetrics(m.metrics) })
    }
  },

  onInput(e) {
    this.setData({ input: e.detail.value })
  },

  async ensureSession() {
    if (this.data.activeSessionId !== null) return this.data.activeSessionId
    const preset = wx.getStorageSync('agentPresetV1')
    let result = await call(this.socket, 'session.create', preset ? { agentPreset: preset } : {})
    if (result.ok !== true && preset && result.error?.message === 'agent-preset-not-found') {
      wx.removeStorageSync('agentPresetV1')
      result = await call(this.socket, 'session.create', {})
    }
    if (result.ok !== true) throw new Error(result.error?.message ?? 'session.create failed')
    const sessionId = result.value.sessionId
    this.setData({ activeSessionId: sessionId })
    this.syncModelLabels()
    if (this.pendingPermission !== null) {
      await this.silentCommand('/permission ' + this.pendingPermission)
      this.pendingPermission = null
    }
    if (this.pendingModel !== null) {
      await this.applyModel(this.pendingModel)
      this.pendingModel = null
    }
    return sessionId
  },

  syncModelLabels() {
    if (this.data.activeSessionId === null) return
    call(this.socket, 'session.models', { sessionId: this.data.activeSessionId })
      .then((result) => {
        if (result.ok !== true || result.value.current === undefined) return
        const current = result.value.current
        const group = (result.value.groups ?? []).find((g) => g.id === current.provider)
        const model = (group?.models ?? []).find((m) => m.id === current.model)
        if (model === undefined) return
        const efforts = model.reasoning?.efforts ?? []
        const match = current.reasoningEffort !== undefined ? efforts.find((ef) => ef.id === current.reasoningEffort) : undefined
        this.setData({
          model: model.id,
          modelLabel: model.name,
          provider: current.provider,
          efforts,
          effort: match !== undefined ? match.id : '',
          effortLabel: match !== undefined ? '推理·' + match.name : '推理',
        })
      })
      .catch(() => {})
  },

  async silentCommand(text) {
    const result = await call(this.socket, 'session.prompt', {
      sessionId: this.data.activeSessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai',
    })
    if (result.ok !== true) throw new Error(result.error?.message ?? 'command failed')
  },

  async send() {
    const text = this.data.input.trim()
    if (text === '' || this.data.sending) return
    this.setData({ input: '', sending: true })
    try {
      if (this.appending !== null) await this.appending
      const sessionId = await this.ensureSession()
      const result = await call(this.socket, 'session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: 'Asia/Shanghai',
      })
      if (result.ok !== true) throw new Error(result.error?.message ?? 'prompt rejected')
      this.todoMsgId = null
      this.pinned = true
      this.push({ kind: 'divider', text: fmtClock(Date.now()) })
      this.push({ kind: 'user', text, clock: fmtClock(Date.now()) })
      this.push({ kind: 'typing', text: '···' })
      const turn = this.turn = { sessionId, fromSeq: this.maxSeq(), sawEvent: false, finished: false, startedAt: Date.now(), firstTokenAt: null, live: new Set() }
      this.watchFallback(turn)
    } catch (error) {
      this.setData({ sending: false })
      wx.showToast({ title: String(error.message ?? error), icon: 'none' })
    }
  },

  onRelayEvent(envelope) {
    const payload = envelope.frame?.payload
    if (payload === undefined) return
    if (envelope.s === 'host') {
      if (payload.type === 'host/session-status' && payload.running === false) this.finishTurn(payload.sessionId)
      return
    }
    if (payload.type === 'session/event') this.onSessionEvent(payload.sessionId, payload.event)
    else if (payload.type === 'approval/requested') this.onApprovalRequested(payload, envelope.frame.rpcId)
    else if (payload.type === 'approval/resolved') this.onApprovalResolved(payload)
    else if (payload.type === 'question/requested') this.onQuestionRequested(payload, envelope.frame.rpcId)
  },

  onApprovalRequested(payload, rpcId) {
    if (payload.sessionId !== this.data.activeSessionId) return
    if (this.settledAsks.has(payload.approvalId)) return
    if (this.data.messages.some((m) => m.kind === 'ask' && m.ask.approvalId === payload.approvalId)) return
    this.push({ kind: 'ask', ask: { type: 'approval', rpcId, sessionId: payload.sessionId, approvalId: payload.approvalId, toolName: payload.toolName ?? '工具', reason: payload.reason ?? '', settled: '' } })
  },

  onApprovalResolved(payload) {
    this.settledAsks.add(payload.approvalId)
    const labels = { 'allowed-once': '已允许', rejected: '已拒绝', cancelled: '已取消', unavailable: '已失效' }
    const i = this.data.messages.findIndex((m) => m.kind === 'ask' && m.ask.approvalId === payload.approvalId)
    if (i >= 0) this.setData({ ['messages[' + i + '].ask.settled']: labels[payload.outcome] ?? '已处理' })
  },

  onQuestionRequested(payload, rpcId) {
    if (payload.sessionId !== this.data.activeSessionId) return
    if (this.settledAsks.has(rpcId)) return
    if (this.data.messages.some((m) => m.kind === 'ask' && m.ask.rpcId === rpcId)) return
    const questions = (payload.questions ?? []).map((q) => ({
      id: q.id,
      question: q.question,
      detail: q.detail ?? '',
      multiSelect: !!q.multiSelect,
      options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? '', on: false })),
      custom: '',
    }))
    this.push({ kind: 'ask', ask: { type: 'question', rpcId, sessionId: payload.sessionId, settled: '', questions } })
  },

  sendApproval(i, outcome) {
    const m = this.data.messages[i]
    if (m === undefined || m.kind !== 'ask' || m.ask.settled) return
    const ask = m.ask
    respond(this.socket, ask.rpcId, { ok: true, value: { sessionId: ask.sessionId, approvalId: ask.approvalId, outcome } })
      .then((receipt) => {
        if (receipt.accepted === true) {
          this.settledAsks.add(ask.approvalId)
          this.setData({ ['messages[' + i + '].ask.settled']: outcome === 'allowed-once' ? '已允许' : '已拒绝' })
        } else wx.showToast({ title: '回答未被接受,可能已被处理', icon: 'none' })
      })
      .catch((error) => wx.showToast({ title: String(error.message ?? error), icon: 'none' }))
  },

  askAllow(e) { this.sendApproval(Number(e.currentTarget.dataset.i), 'allowed-once') },

  askDeny(e) { this.sendApproval(Number(e.currentTarget.dataset.i), 'rejected') },
  askPick(e) {
    const i = Number(e.currentTarget.dataset.i)
    const qi = Number(e.currentTarget.dataset.qi)
    const oi = Number(e.currentTarget.dataset.oi)
    const m = this.data.messages[i]
    if (m === undefined || m.kind !== 'ask' || m.ask.settled) return
    const q = m.ask.questions[qi]
    const patch = {}
    if (!q.multiSelect) {
      q.options.forEach((o, k) => { patch['messages[' + i + '].ask.questions[' + qi + '].options[' + k + '].on'] = k === oi })
      this.setData(patch)
      if (m.ask.questions.length === 1) this.submitAsk(i)
    } else {
      patch['messages[' + i + '].ask.questions[' + qi + '].options[' + oi + '].on'] = !q.options[oi].on
      this.setData(patch)
    }
  },

  askCustom(e) {
    const i = Number(e.currentTarget.dataset.i)
    const qi = Number(e.currentTarget.dataset.qi)
    this.setData({ ['messages[' + i + '].ask.questions[' + qi + '].custom']: e.detail.value })
  },

  submitAsk(i) {
    const m = this.data.messages[i]
    if (m === undefined || m.kind !== 'ask' || m.ask.settled) return
    const answers = []
    for (const q of m.ask.questions) {
      const selected = q.options.filter((o) => o.on).map((o) => o.label)
      const custom = q.custom.trim()
      if (selected.length === 0 && custom === '') { wx.showToast({ title: '还有问题未回答', icon: 'none' }); return }
      answers.push({ id: q.id, selected, ...(custom !== '' ? { custom } : {}) })
    }
    const ask = m.ask
    respond(this.socket, ask.rpcId, { ok: true, value: { sessionId: ask.sessionId, answer: { answers } } })
      .then((receipt) => {
        if (receipt.accepted === true) {
          this.settledAsks.add(ask.rpcId)
          this.setData({ ['messages[' + i + '].ask.settled']: '已回答' })
        } else wx.showToast({ title: '回答未被接受,可能已被处理', icon: 'none' })
      })
      .catch((error) => wx.showToast({ title: String(error.message ?? error), icon: 'none' }))
  },

  askSubmit(e) { this.submitAsk(Number(e.currentTarget.dataset.i)) },

  askCancel(e) {
    const i = Number(e.currentTarget.dataset.i)
    const m = this.data.messages[i]
    if (m === undefined || m.kind !== 'ask' || m.ask.settled) return
    respond(this.socket, m.ask.rpcId, { ok: false, error: { code: 'cancelled', message: 'cancelled', details: {} } })
      .then((receipt) => {
        if (receipt.accepted === true) {
          this.settledAsks.add(m.ask.rpcId)
          this.setData({ ['messages[' + i + '].ask.settled']: '已取消' })
        } else wx.showToast({ title: '取消未被接受', icon: 'none' })
      })
      .catch((error) => wx.showToast({ title: String(error.message ?? error), icon: 'none' }))
  },

  loadHistoryTodos(sessionId) {
    call(this.socket, 'session.history', { sessionId })
      .then((result) => {
        if (result.ok !== true) return
        const perm = result.value.projections?.values?.permissions?.currentValue
        if (perm !== undefined) this.setData({ permission: perm })
        let last = null
        for (const entry of result.value.events ?? []) {
          if (entry.event?.type === 'todo/write') last = entry.event
        }
        if (last === null) return
        const todos = (last.data?.todos ?? []).map((t) => ({ content: t.content ?? '', status: t.status ?? 'pending' }))
        if (todos.length === 0) return
        const msgs = this.data.messages
        let at = msgs.length
        for (let k = msgs.length - 1; k >= 0; k--) {
          if (msgs[k].kind !== 'divider' && (msgs[k].seq ?? 0) <= (last.seq ?? 0)) { at = k + 1; break }
        }
        const id = this.nextId()
        this.todoMsgId = id
        this.setData({ messages: msgs.slice(0, at).concat({ id, kind: 'todo', items: todos }).concat(msgs.slice(at)) })
      })
      .catch(() => {})
  },

  openNav() {
    const items = this.data.messages
      .filter((m) => m.kind === 'user' && m.text !== '')
      .map((m) => ({ mid: m.id, clock: m.clock ?? '', brief: m.text.length > 26 ? m.text.slice(0, 26) + '…' : m.text }))
    this.setData({ navOpen: true, drawerOpen: false, navItems: items })
  },

  closeNav() {
    this.setData({ navOpen: false })
  },

  jumpTo(e) {
    const mid = Number(e.currentTarget.dataset.mid)
    const q = wx.createSelectorQuery().in(this)
    q.select('.messages').fields({ rect: true, scrollOffset: true })
    q.select('#msg-' + mid).boundingClientRect()
    q.exec((res) => {
      const box = res[0]
      const msg = res[1]
      if (box === null || msg === null) return
      let top = Math.max(0, box.scrollTop + msg.top - box.top - 10)
      if (Math.abs(top - this.data.scrollTop) < 1) top += 1
      this.setData({ navOpen: false, scrollTop: top })
      this.pinned = false
    })
  },

  onTodoWrite(todos) {
    const items = todos.map((t) => ({ content: t.content ?? '', status: t.status ?? 'pending' }))
    const i = this.data.messages.findIndex((m) => m.id === this.todoMsgId)
    if (i >= 0) {
      this.setData({ ['messages[' + i + '].items']: items })
      if (this.pinned) this.stickBottom()
      return
    }
    const id = this.nextId()
    this.todoMsgId = id
    this.push({ id, kind: 'todo', items })
  },

  hasOpenAsk(sessionId) {
    return this.data.messages.some((m) => m.kind === 'ask' && m.ask.sessionId === sessionId && !m.ask.settled)
  },

  onSessionEvent(sessionId, event) {
    if (event.type === 'permission/preset') {
      if (sessionId === this.data.activeSessionId && event.data?.preset !== undefined) this.setData({ permission: event.data.preset })
    }
    const turn = this.turn
    if (turn === null || turn.finished || turn.sessionId !== sessionId) return
    if (event.type === 'todo/write') { turn.sawEvent = true; this.onTodoWrite(event.data?.todos ?? []); return }
    if (event.type === 'assistant/message') { turn.sawEvent = true; this.commitAssistant(event); return }
    if (event.type === 'tool/call') { turn.sawEvent = true; this.commitToolCall(event); return }
    if (event.type !== 'assistant/chunk') return
    turn.sawEvent = true
    const chunk = event.data?.chunk
    if (chunk !== undefined && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')) {
      if (turn.firstTokenAt === null) turn.firstTokenAt = Date.now()
      this.appendChunk(chunk)
    }
  },

  appendChunk(chunk) {
    if (this.stream === null) {
      this.dropTyping()
      const id = this.nextId()
      this.push({ id, kind: 'agent', blocks: [], reasoning: null, tokens: null, thinkingOpen: true, traces: [], seq: 0, streaming: true, foot: '' })
      this.stream = { id, text: '', reasoning: '', startedAt: Date.now(), firstTokenAt: null, dirty: false, timer: null }
    }
    const s = this.stream
    if (s.firstTokenAt === null) s.firstTokenAt = Date.now()
    if (chunk.type === 'text-delta') s.text += chunk.text
    else s.reasoning += chunk.text
    s.dirty = true
    if (s.timer === null) s.timer = setTimeout(() => this.flushStream(), 200)
  },

  flushStream() {
    const s = this.stream
    if (s === null) return
    s.timer = null
    if (!s.dirty) return
    s.dirty = false
    const idx = this.data.messages.findIndex((m) => m.id === s.id)
    if (idx < 0) return
    const patch = {}
    patch['messages[' + idx + '].blocks'] = mdBlocks(s.text)
    patch['messages[' + idx + '].reasoning'] = s.reasoning === '' ? null : s.reasoning
    this.setData(patch)
    if (this.pinned) this.stickBottom()
  },

  dropStream() {
    const s = this.stream
    this.stream = null
    if (s === null) return
    if (s.timer !== null) clearTimeout(s.timer)
    this.setData({ messages: this.data.messages.filter((m) => m.id !== s.id) })
  },

  commitAssistant(event) {
    const turn = this.turn
    const data = event.data ?? {}
    const blocks = data.message?.content ?? []
    let text = ''
    let reasoning = null
    for (const block of blocks) {
      if (block.type === 'text') text += block.text
      else if (block.type === 'reasoning' && reasoning === null) reasoning = block.text
    }
    const seq = typeof event.seq === 'number' ? event.seq : 0
    if (turn !== null && seq > 0) {
      if (turn.live.has(seq)) return
      turn.live.add(seq)
    }
    const s = this.stream
    this.dropStream()
    if (text === '' && reasoning === null) return
    const now = typeof event.time === 'number' ? event.time : Date.now()
    const usage = data.usage
    const out = usage !== undefined && Number.isFinite(usage.outputTokens) ? usage.outputTokens : null
    let metrics = null
    if (s !== null) {
      metrics = {
        time: now,
        runMs: Math.max(0, now - s.startedAt),
        tps: s.firstTokenAt !== null && out !== null && out > 0 ? Math.round((out * 1000) / Math.max(1, now - s.firstTokenAt)) : null,
        out,
      }
    } else {
      metrics = { time: now }
    }
    this.dropTyping()
    this.pushAgent({ kind: 'agent', text, reasoning, tokens: usage !== undefined ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : null, seq, metrics })
  },

  commitToolCall(event) {
    const turn = this.turn
    const seq = typeof event.seq === 'number' ? event.seq : 0
    if (turn !== null && seq > 0) {
      if (turn.live.has(seq)) return
      turn.live.add(seq)
    }
    this.push({ kind: 'agent', html: '', text: '', reasoning: null, tokens: null, thinkingOpen: false, traces: [{ tool: event.data?.name ?? 'tool', summary: '', dur: '' }], seq, foot: '' })
  },

  finishTurn(sessionId) {
    const turn = this.turn
    if (turn === null || turn.finished || turn.sessionId !== sessionId) return
    turn.finished = true
    this.setData({ sending: false })
    this.appending = api.getSessionSurface(sessionId, this.deviceHeader()).then((res) => {
      this.dropTyping()
      this.dropStream()
      const fresh = (res.messages ?? []).filter((m) => (m.seq ?? 0) > turn.fromSeq && m.kind !== 'user' && !turn.live.has(m.seq))
      for (const m of fresh) this.pushAgent(m)
      if (turn.startedAt !== undefined && turn.firstTokenAt !== null) {
        const now = Date.now()
        const msgs = this.data.messages
        for (let k = msgs.length - 1; k >= 0; k--) {
          const msg = msgs[k]
          if (msg.kind !== 'agent' || !msg.blocks || msg.blocks.length === 0) continue
          if (msg.foot) break
          const decodeMs = Math.max(1, now - turn.firstTokenAt)
          const tps = typeof msg.out === 'number' && msg.out > 0 ? Math.round((msg.out * 1000) / decodeMs) : null
          this.setData({ ['messages[' + k + '].foot']: fmtMetrics({ time: now, runMs: now - turn.startedAt, ttftMs: turn.firstTokenAt - turn.startedAt, tps }) })
          break
        }
      }
    }).catch(() => {
      this.dropTyping()
    }).finally(() => {
      this.appending = null
      if (this.turn === turn) this.turn = null
    })
  },

  recoverTurn() {
    const turn = this.turn
    if (turn === null || turn.finished) return
    call(this.socket, 'session.list', {})
      .then((result) => {
        if (this.turn !== turn || turn.finished || result.ok !== true) return
        const item = (result.value.items ?? []).find((s) => s.sessionId === turn.sessionId)
        if (item !== undefined && item.running === false) this.finishTurn(turn.sessionId)
      })
      .catch(() => {})
  },

  async watchFallback(turn) {
    for (let i = 0; i < 80 && !turn.finished && this.destroyed !== true; i++) {
      await sleep(1500)
      if (turn.finished) return
      if (turn.sawEvent || this.hasOpenAsk(turn.sessionId)) continue
      try {
        const res = await api.getSessionSurface(turn.sessionId, this.deviceHeader())
        const fresh = (res.messages ?? []).filter((m) => (m.seq ?? 0) > turn.fromSeq && m.kind !== 'user')
        if (fresh.length > 0) {
          this.finishTurn(turn.sessionId)
          return
        }
      } catch { /* surface unreachable — keep watching */ }
    }
    if (!turn.finished && this.destroyed !== true && !this.hasOpenAsk(turn.sessionId)) this.finishTurn(turn.sessionId)
  },

  resetTurn() {
    this.todoMsgId = null
    if (this.turn !== null) this.turn.finished = true
    this.turn = null
    const s = this.stream
    this.stream = null
    if (s !== null && s.timer !== null) clearTimeout(s.timer)
  },

  setPermission(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ permission: id })
    if (this.data.activeSessionId !== null) {
      this.silentCommand('/permission ' + id).catch((error) => wx.showToast({ title: String(error.message ?? error), icon: 'none' }))
      const label = PERMISSIONS.find((p) => p.id === id)?.label ?? id
      this.push({ kind: 'divider', text: '权限预设 → ' + label })
    } else {
      this.pendingPermission = id
    }
  },

  toggleThinking(e) {
    const id = Number(e.currentTarget.dataset.id)
    this.setData({
      messages: this.data.messages.map((m) => (m.id === id ? { ...m, thinkingOpen: !m.thinkingOpen } : m)),
    })
  },

  openSheet() {
    this.setData({ sheetOpen: true })
  },

  closeSheet() {
    this.setData({ sheetOpen: false })
  },

  pickCommand(e) {
    this.setData({ sheetOpen: false, input: e.currentTarget.dataset.token + ' ' })
  },

  openDrawer() {
    this.setData({ drawerOpen: true, sessionsLoading: true })
    this.loadWorkspaceTree()
  },

  loadWorkspaceTree() {
    const titles = api.getSessions(this.deviceHeader()).then((res) => {
      const map = {}
      for (const item of res.sessions ?? []) {
        map[item.id] = item.title ?? (item.cwd !== null ? item.cwd.split(/[\/]/).filter(Boolean).pop() : '未命名会话')
      }
      return map
    })
    const tree = call(this.socket, 'workspace.list', {})
    Promise.all([titles, tree]).then(([titleMap, result]) => {
      const currentTitle = this.data.activeSessionId !== null ? ((titleMap[this.data.activeSessionId] ?? this.data.currentTitle) || '新会话') : ''
      if (result.ok !== true) throw new Error(result.error?.message ?? 'workspace.list failed')
      const archived = new Set(result.value.archivedSessionIds ?? [])
      const inFolders = new Set()
      const folders = (result.value.items ?? []).map((ws) => {
        const sessions = (ws.sessionIds ?? []).filter((id) => !archived.has(id)).map((id) => {
          inFolders.add(id)
          return { id, title: titleMap[id] ?? id.slice(0, 16) }
        })
        let path = String(ws.path ?? '')
        const BS = String.fromCharCode(92)
        const norm = path.split(String.fromCharCode(47)).join(BS).toLowerCase()
        const tail = String(ws.title ?? '').toLowerCase()
        if (tail !== '' && norm.endsWith(BS + tail)) path = path.slice(0, -(tail.length + 1))
        return { workspaceId: ws.workspaceId, title: ws.title, path, sessions }
      })
      const ungrouped = Object.keys(titleMap).filter((id) => !inFolders.has(id) && !archived.has(id)).map((id) => ({ id, title: titleMap[id] }))
      this.setData({ folders, ungrouped, sessionsLoading: false, currentTitle })
    }).catch((error) => {
      this.setData({ sessionsLoading: false })
      wx.showToast({ title: '工作区加载失败: ' + String(error.message ?? error), icon: 'none' })
    })
  },

  newFolder() {
    this.openDialog({ title: '新建文件夹', label: '目录路径', hint: '电脑上的目录绝对路径', placeholder: 'E:/project_ai/xxx', action: 'folder-new' })
  },

  openDialog(opts) {
    this.setData({ dialog: { open: true, value: '', confirmText: '确定', max: 0, ...opts } })
  },

  onDialogInput(e) {
    this.setData({ 'dialog.value': e.detail.value })
  },

  cancelDialog() {
    this.setData({ 'dialog.open': false })
  },

  confirmDialog() {
    const d = this.data.dialog
    const value = String(d.value ?? '').trim()
    if (value === '') {
      wx.showToast({ title: '请输入内容', icon: 'none' })
      return
    }
    this.setData({ 'dialog.open': false })
    const fail = (error) => wx.showToast({ title: String(error.message ?? error), icon: 'none' })
    if (d.action === 'folder-new') {
      call(this.socket, 'workspace.create', { path: value })
        .then((r) => { if (r.ok !== true) throw new Error(r.error?.message ?? '创建失败'); this.loadWorkspaceTree() })
        .catch(fail)
    } else if (d.action === 'folder-rename') {
      call(this.socket, 'workspace.rename', { workspaceId: d.id, title: value })
        .then((r) => { if (r.ok !== true) throw new Error(r.error?.message ?? '重命名失败'); this.loadWorkspaceTree() })
        .catch(fail)
    } else if (d.action === 'current-rename') {
      call(this.socket, 'session.rename', { sessionId: this.data.activeSessionId, title: value })
        .then((r) => {
          if (r.ok !== true) throw new Error(r.error?.message ?? '重命名失败')
          wx.setNavigationBarTitle({ title: value })
          this.setData({ currentTitle: value })
          this.loadWorkspaceTree()
        })
        .catch(fail)
    } else if (d.action === 'session-rename') {
      call(this.socket, 'session.rename', { sessionId: d.id, title: value })
        .then((r) => { if (r.ok !== true) throw new Error(r.error?.message ?? '重命名失败'); this.loadWorkspaceTree() })
        .catch(fail)
    }
  },

  folderMenu(e) {
    const { id, title } = e.currentTarget.dataset
    wx.showActionSheet({
      itemList: ['新建会话', '重命名', '删除文件夹'],
      success: (res) => {
        if (res.tapIndex === 0) this.createSessionIn(id)
        else if (res.tapIndex === 1) {
          this.openDialog({ title: '重命名文件夹', label: '名称', value: title, max: 24, action: 'folder-rename', id })
        } else if (res.tapIndex === 2) {
          wx.showModal({
            title: '删除文件夹',
            content: '仅删除文件夹分组',
            success: (m) => {
              if (!m.confirm) return
              call(this.socket, 'workspace.delete', { workspaceId: id }).then((r) => {
                if (r.ok !== true) throw new Error(r.error?.message ?? '删除失败')
                this.loadWorkspaceTree()
              }).catch((error) => wx.showToast({ title: String(error.message ?? error), icon: 'none' }))
            },
          })
        }
      },
    })
  },

  createSessionIn(workspaceId) {
    this.resetTurn()
    call(this.socket, 'session.create', { workspaceId }).then((result) => {
      if (result.ok !== true) throw new Error(result.error?.message ?? '创建失败')
      this.setData({ drawerOpen: false, activeSessionId: result.value.sessionId, currentTitle: '新会话', messages: [{ id: this.nextId(), kind: 'divider', text: '新会话' }], scrollTop: 0 })
      this.pinned = true
      this.lastTop = 0
      wx.setNavigationBarTitle({ title: '新会话' })
    }).catch((error) => wx.showToast({ title: String(error.message ?? error), icon: 'none' }))
  },

  sessionMenu(e) {
    const { id, title } = e.currentTarget.dataset
    wx.showActionSheet({
      itemList: ['重命名', '分叉会话', '归档会话'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.openDialog({ title: '重命名会话', label: '名称', value: title, max: 24, action: 'session-rename', id })
        } else if (res.tapIndex === 1) {
          call(this.socket, 'session.fork', { sessionId: id }).then((r) => {
            if (r.ok !== true) throw new Error(r.error?.message ?? '分叉失败')
            const forkedId = r.value.sessionId ?? r.value.session?.id
            this.resetTurn()
            this.setData({ drawerOpen: false, activeSessionId: forkedId, currentTitle: '分叉会话', messages: [{ id: this.nextId(), kind: 'divider', text: '分叉会话' }], scrollTop: 0 })
            this.pinned = true
            this.lastTop = 0
          }).catch((error) => wx.showToast({ title: String(error.message ?? error), icon: 'none' }))
        } else if (res.tapIndex === 2) {
          call(this.socket, 'workspace.archiveSession', { sessionId: id }).then((r) => {
            if (r.ok !== true) throw new Error(r.error?.message ?? '归档失败')
            wx.showToast({ title: '已归档', icon: 'success' })
            this.loadWorkspaceTree()
          }).catch((error) => wx.showToast({ title: String(error.message ?? error), icon: 'none' }))
        }
      },
    })
  },

  renameCurrentSession() {
    if (this.data.activeSessionId === null) {
      wx.showToast({ title: '还没有会话,先发一条消息', icon: 'none' })
      return
    }
    this.openDialog({ title: '重命名会话', label: '名称', value: this.data.currentTitle, max: 24, action: 'current-rename' })
  },

  toggleFolder(e) {
    const id = e.currentTarget.dataset.id
    const open = this.data.foldOpen[id] === true
    this.setData({ ['foldOpen.' + id]: !open })
  },

  toggleUngrouped() {
    this.setData({ ungroupedOpen: !this.data.ungroupedOpen })
  },

  closeDrawer() {
    this.setData({ drawerOpen: false })
  },

  openHistory(e) {
    this.loadSession(e.currentTarget.dataset.id, e.currentTarget.dataset.title)
  },

  loadSession(id, title) {
    wx.setNavigationBarTitle({ title })
    this.resetTurn()
    api.getSessionSurface(id, this.deviceHeader())
      .then((res) => {
        const messages = [{ id: this.nextId(), kind: 'divider', text: title }]
        let maxSeq = 0
        for (const m of res.messages ?? []) {
          maxSeq = Math.max(maxSeq, m.seq ?? 0)
          if (m.kind === 'user') {
            if (typeof m.time === 'number') messages.push({ id: this.nextId(), kind: 'divider', text: fmtClock(m.time) })
            messages.push({ id: this.nextId(), kind: 'user', text: m.text, seq: m.seq, clock: typeof m.time === 'number' ? fmtClock(m.time) : '' })
          }
          else messages.push({ id: this.nextId(), kind: 'agent', blocks: mdBlocks(m.text), text: m.text, reasoning: m.reasoning, tokens: m.tokens, out: (m.metrics && m.metrics.out) || null, thinkingOpen: true, traces: [], seq: m.seq, foot: fmtMetrics(m.metrics) })
        }
        this.setData({
          drawerOpen: false,
          activeSessionId: id,
          currentTitle: title,
          messages,
          scrollTop: 0,
        })
        this.pinned = true
        this.lastTop = 0
        this.syncLastAgent()
        this.syncModelLabels()
        this.loadHistoryTodos(id)
        setTimeout(() => {
          if (this.destroyed) return
          this.stickBottom()
        }, 200)
      })
      .catch((error) => wx.showToast({ title: '读取失败: ' + String(error.message ?? error), icon: 'none' }))
  },

  copyMsg(e) {
    const m = this.data.messages[Number(e.currentTarget.dataset.i)]
    if (m === undefined || !m.text) return
    wx.setClipboardData({ data: m.text })
  },

  msgMenu(e) {
    const i = Number(e.currentTarget.dataset.i)
    const m = this.data.messages[i]
    if (m === undefined || !m.text) return
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || {}
    const x = t.clientX ?? e.detail?.x ?? 200
    const y = t.clientY ?? e.detail?.y ?? 300
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const width = 160
    const left = Math.min(Math.max(x - width / 2, 10), info.windowWidth - width - 10)
    const above = y > 150
    this.setData({
      msgMenu: {
        open: true,
        id: m.id,
        top: above ? y - 96 : y + 28,
        left,
        arrowLeft: Math.min(Math.max(x - left - 7, 14), width - 28),
        above,
      },
    })
  },

  closeMsgMenu() {
    this.setData({ 'msgMenu.open': false })
  },

  menuCopyAll() {
    const m = this.data.messages.find((x) => x.id === this.data.msgMenu.id)
    this.closeMsgMenu()
    if (m === undefined || !m.text) return
    wx.setClipboardData({ data: m.text })
  },

  menuCopySelect() {
    const m = this.data.messages.find((x) => x.id === this.data.msgMenu.id)
    if (m === undefined || !m.text) return this.closeMsgMenu()
    this.setData({ selectingId: m.id, 'msgMenu.open': false })
  },

  endSelect() {
    this.setData({ selectingId: 0 })
  },

  likeMsg() {
    if (this.data.activeSessionId === null) return
    this.silentCommand('/feedback 👍')
      .then(() => wx.showToast({ title: '已记录反馈', icon: 'none' }))
      .catch((error) => wx.showToast({ title: String(error.message ?? error), icon: 'none' }))
  },

  forkMsg(e) {
    const seq = Number(e.currentTarget.dataset.seq)
    if (!seq || this.data.activeSessionId === null || this.forking) return
    this.forking = true
    call(this.socket, 'session.fork', { sessionId: this.data.activeSessionId, atSeq: seq })
      .then((result) => {
        if (result.ok !== true) throw new Error(result.error?.message ?? 'fork failed')
        wx.showToast({ title: '已在新会话中分支', icon: 'none' })
        this.loadSession(result.value.sessionId, (this.data.currentTitle || this.data.name) + ' · 分支')
      })
      .catch((error) => wx.showToast({ title: String(error.message ?? error), icon: 'none' }))
      .then(() => { this.forking = false })
  },

  openModelSheet() {
    this.setData({ modelSheetOpen: true, modelsLoading: true })
    const load = this.data.activeSessionId !== null
      ? call(this.socket, 'session.models', { sessionId: this.data.activeSessionId })
      : call(this.socket, 'llm.models', {})
    load.then((result) => {
      if (result.ok !== true) throw new Error(result.error?.message ?? 'catalog failed')
      const value = result.value
      const models = []
      for (const group of value.groups ?? []) {
        for (const model of group.models ?? []) {
          models.push({ id: model.id, name: model.name, provider: group.id, providerName: group.name, efforts: model.reasoning?.efforts ?? [], defaultEffort: model.reasoning?.defaultEffort ?? '' })
        }
      }
      const patch = { models, modelsLoading: false }
      if (value.current !== undefined) {
        const current = models.find((m) => m.id === value.current.model) ?? models[0]
        if (current !== undefined) {
          patch.model = current.id
          patch.modelLabel = current.name
          patch.provider = current.provider
          patch.efforts = current.efforts
          const curEffort = value.current.reasoningEffort
          if (curEffort !== undefined) {
            const match = current.efforts.find((ef) => ef.id === curEffort)
            if (match !== undefined) {
              patch.effort = match.id
              patch.effortLabel = '推理·' + match.name
            }
          }
        }
      }
      this.setData(patch)
    }).catch((error) => {
      this.setData({ modelsLoading: false })
      wx.showToast({ title: '模型目录加载失败: ' + String(error.message ?? error), icon: 'none' })
    })
  },

  closeModelSheet() {
    this.setData({ modelSheetOpen: false })
  },

  pickModel(e) {
    const { id, provider } = e.currentTarget.dataset
    const model = this.data.models.find((m) => m.id === id && m.provider === provider)
    if (model === undefined) return
    const efforts = model.efforts ?? []
    const fallback = efforts.find((ef) => ef.id === model.defaultEffort) ?? efforts[0] ?? null
    this.setData({
      modelSheetOpen: false,
      model: model.id,
      modelLabel: model.name,
      provider: model.provider,
      efforts,
      effort: fallback?.id ?? '',
      effortLabel: fallback?.name ?? '推理',
    })
    if (this.data.activeSessionId !== null) {
      this.applyModel({ id: model.id, provider: model.provider, effort: fallback?.id })
    } else {
      this.pendingModel = { id: model.id, provider: model.provider, effort: fallback?.id }
    }
  },

  async applyModel(selection) {
    const payload = {
      sessionId: this.data.activeSessionId,
      provider: selection.provider,
      model: selection.id,
    }
    if (selection.effort !== undefined && selection.effort !== '') payload.reasoningEffort = selection.effort
    const result = await call(this.socket, 'session.selectModel', payload)
    if (result.ok !== true) throw new Error(result.error?.message ?? 'selectModel failed')
  },

  openEffortSheet() {
    if (this.data.efforts.length === 0) {
      wx.showToast({ title: '当前模型没有推理等级', icon: 'none' })
      return
    }
    this.setData({ effortSheetOpen: true })
  },

  closeEffortSheet() {
    this.setData({ effortSheetOpen: false })
  },

  pickEffort(e) {
    const { id, label } = e.currentTarget.dataset
    this.setData({ effortSheetOpen: false, effort: id, effortLabel: '推理·' + label })
    if (this.data.activeSessionId !== null && this.data.model !== '') {
      this.applyModel({ id: this.data.model, provider: this.data.provider, effort: id })
        .catch((error) => wx.showToast({ title: String(error.message ?? error), icon: 'none' }))
    } else if (this.data.model !== '') {
      this.pendingModel = { id: this.data.model, provider: this.data.provider, effort: id }
    }
  },
})
