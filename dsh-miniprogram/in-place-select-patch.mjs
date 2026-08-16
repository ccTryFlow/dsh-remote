import { readFileSync, writeFileSync } from 'node:fs'

function patch(file, pairs) {
  let src = readFileSync(file, 'utf8')
  for (const [from, to] of pairs) {
    if (!src.includes(from)) throw new Error(file + ' 未找到: ' + String(from).slice(0, 50))
    src = src.replace(from, to)
  }
  writeFileSync(file, src)
  console.log('OK', file, pairs.length + ' 处')
}

patch('pages/chat/index.wxml', [
[
`      <view class="user-block" data-i="{{index}}" bind:longpress="msgMenu">
        <view class="user-bubble">{{item.text}}</view>`,
`      <view class="user-block">
        <view class="user-bubble"><text user-select>{{item.text}}</text></view>`
],
[
`      <view wx:if="{{item.html}}" class="agent-bubble md-body" data-i="{{index}}" bind:longpress="msgMenu">
        <rich-text nodes="{{item.html}}" />
      </view>`,
`      <view wx:if="{{item.id === selectingId}}" class="agent-selecting">
        <view class="select-bar">
          <text class="select-tip">长按拖动选择文字</text>
          <text class="select-done" bind:tap="endSelect">完成</text>
        </view>
        <text user-select class="agent-plain">{{item.text}}</text>
      </view>
      <view wx:elif="{{item.html}}" class="agent-bubble md-body" data-i="{{index}}" bind:longpress="msgMenu">
        <rich-text nodes="{{item.html}}" />
      </view>`
],
[
`<view wx:if="{{selectOpen}}" class="dialog-scrim" bind:tap="closeSelect" />
<view wx:if="{{selectOpen}}" class="dialog select-dialog">
  <view class="dialog-title">选择复制</view>
  <scroll-view scroll-y class="select-body">
    <text user-select>{{selectText}}</text>
  </scroll-view>
  <view class="dialog-save" bind:tap="closeSelect">关闭</view>
</view>

`,
``
],
])

patch('pages/chat/index.js', [
[
`    selectOpen: false,
    selectText: '',`,
`    selectingId: 0,`
],
[
`  menuCopySelect() {
    const m = this.data.messages[this.data.msgMenu.i]
    if (m === undefined || !m.text) return this.closeMsgMenu()
    this.setData({ selectOpen: true, selectText: m.text, 'msgMenu.open': false })
  },

  closeSelect() {
    this.setData({ selectOpen: false })
  },`,
`  menuCopySelect() {
    const m = this.data.messages[this.data.msgMenu.i]
    if (m === undefined || !m.text) return this.closeMsgMenu()
    this.setData({ selectingId: m.id, 'msgMenu.open': false })
  },

  endSelect() {
    this.setData({ selectingId: 0 })
  },`
],
])

let css = readFileSync('pages/chat/index.wxss', 'utf8')
const cssFrom = `.select-dialog {
  max-height: 76vh;
  display: flex;
  flex-direction: column;
}
.select-body {
  max-height: 48vh;
  margin-top: 20rpx;
  padding: 24rpx;
  background: var(--surface-secondary);
  border-radius: 16rpx;
  font-size: 26rpx;
  line-height: 1.7;
  box-sizing: border-box;
}
`
if (!css.includes(cssFrom)) throw new Error('wxss 未找到 select 块')
css = css.replace(cssFrom, '')
css += `
.agent-selecting {
  padding: 4rpx 8rpx 8rpx;
}

.select-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8rpx;
}

.select-tip {
  font-size: 22rpx;
  color: #999999;
}

.select-done {
  font-size: 24rpx;
  color: #5D5DFF;
}

.agent-plain {
  display: block;
  font-size: 28rpx;
  line-height: 1.75;
}
`
writeFileSync('pages/chat/index.wxss', css)
console.log('OK wxss')
