# dsh-relay-plugin

deepseek-harness 的中继 bundle 插件:随 `dsh web` 在宿主进程内运行,负责设备配对、LAN 监听与(可选)云中继上行,把小程序的 RPC 帧和 harness 的事件流接起来。无需单独进程。

## 安装

在 deepseek-harness 仓库内:

```sh
pnpm dsh plugin --profile web add link:/path/to/dsh-relay-plugin
pnpm dsh web
```

link 方式指向源码目录,改 `src/index.js` 后重启 `dsh web` 即生效。

## 运行行为

- 随宿主启动,LAN 监听 `0.0.0.0:4010`(`RELAY_LAN_PORT` 可改);端口被占时只警告不崩溃
- 云上行:设置 `RELAY_CLOUD_URL=wss://relay.example.com`(或 `~/.dsh/relay-lan.json` 的 `cloudUrl`)后出站连云中继;**默认为空 = 只走局域网**
- 启动时打印 6 位配对码 + 终端二维码(5 分钟有效);未绑定时持续换新,绑定后安静(要常驻换新设 `RELAY_CLOUD_PAIRING=1`)
- 绑定持久化在 `~/.dsh/relay-lan.json`(deviceId + cloud token),重启免配对
- 桥接 harness 的 `/api/events.mux` 与 `/api/events.host` 两条下行 WS,以 `{t:'ev',s:'mux'|'host',frame}` 帧转发给客户端;RPC 帧透传到本进程 `/api`

## 本地接口(LAN 端口)

`/health` `/bindings` `/pair/claim` `/devices/rename` `/devices/unbind` `/sessions` `/sessions/<id>/surface`(`?raw=1` 调试原始事件)、WS `/client`。单端点模型:设备列表始终只有本机这一台,多用户按 userId 隔离。

## 已实测的 harness RPC(供参考)

- `session.create {cwd?|workspaceId?, agentPreset?}` → `{sessionId, agentPreset}`
- `session.prompt {sessionId, mode:'queue', content:[{type:'text',text}], clientTimeZone}`
- `session.models {sessionId}`;`session.selectModel {sessionId, provider, model, reasoningEffort}`(**必须带 provider**;`effort` 字段会被静默丢弃)
- `session.rename` / `session.fork {sessionId, atSeq?}`;没有 `session.delete`,会话只能归档(`workspace.archiveSession`)
- `workspace.list / create / rename / delete`
- `llm.models {}`、`settings.describe {}`、`agentPreset.list {}`
- RPC 信封:`POST /api/<method>`,体 `{"type":"client-request","rpcId":"<uuid>","method":"<method>","payload":{...}}`

事件流注意:SessionEvent 载荷在 `event.data`;快照事件流是压缩过的(step/chunk 折叠),历史消息的 TTFT/tok-s 物理不可得。
