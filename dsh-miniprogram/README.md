# dsh-miniprogram

deepseek-harness 的微信小程序客户端(原生开发,无构建步骤)。

## 使用

1. **必改** `utils/config.js` 的 `RELAY_BASE`(中继地址,https 起头,WS 自动推导;局域网直连填 `http://<PC内网IP>:4010`)。
2. 微信开发者工具 → 导入本目录(appid 为 `touristappid`,可换自己的测试号)。
3. 真机/体验版需在小程序后台配置合法域名(request:`https://<中继域名>` + socket:`wss://<中继域名>`)。
4. 设备页 → 连接设备 → 输入 PC 终端打印的 6 位码(或扫码)→ 绑定。

## 功能

- 聊天:流式输出 + 打字机渲染,思考过程、工具轨迹、token 指标(用时/首 token/tok-s)
- 消息操作:复制/点赞/分支(`session.fork`),长按选择复制
- 工作区抽屉:文件夹树、会话管理(重命名/分叉/归档)、新建会话
- 工具栏:权限(只读/工作区/完全)、模型与推理等级实时目录
- 人工审批/问询面板、任务清单(todo)卡、对话目录跳转
- 我的页:设备管理(重命名/解绑)、Agent 预设选择

## 页面

| 页面 | 数据源 |
|---|---|
| pages/devices | `GET /bindings` |
| pages/connect | `POST /pair/claim` + `wx.scanCode` |
| pages/chat | WS `/client`(t:req/t:res/t:ev)+ `POST /api/<method>` RPC |
| pages/profile | `GET /bindings`、`agentPreset.list` |

## 边界

- 用户身份为安装时随机生成的 userId(`x-mock-user` 头),信任根是配对码/设备 token;生产环境建议接 `wx.login` + code2session。
- agent 跑在 PC 上,PC 离线无法使用;历史缓存(离线翻阅)在路线图中。
