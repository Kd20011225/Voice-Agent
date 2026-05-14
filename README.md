# Voice Agent 访客登记系统

工业园区电话接入式 AI 门岗 Demo：访客拨打入口号码，Voice Agent 用自然中文采集车牌、来访单位、手机号和事由，校验通过后写入本地 SQLite，并通过 PushPlus 推送到保安微信。系统还支持回访识别和门卫自然语言查询。

## 架构

```text
访客手机
  -> Twilio Voice Number
  -> POST /voice 返回 <Connect><Stream>
  -> Node.js Express + WebSocket (/media)
  <-> OpenAI Realtime API
      -> Dialogue Layer: 三轮问询、回访确认、风险兜底、工具调用
      -> Domain Layer: 信息解析、字段清洗、车牌/手机号校验、统计查询
      -> SQLite: visitors / risk_events
      -> PushPlus: 保安微信通知

门卫查询:
保安电话 -> /guard-voice -> /guard-media <-> OpenAI Realtime -> SQLite 查询
HTTP 调试 -> /guard/query
```

## 技术选型

- 电话接入选择 Twilio Voice + Media Stream：Webhook 和 WebSocket 音频流成熟，适合快速跑通端到端 Demo；生产环境可按国内号码和合规要求替换为阿里云语音或 SIP Trunk。
- 语音模型选择 OpenAI Realtime API：同一连接内完成低延迟语音输入、VAD、转写、语音输出和函数调用，避免 ASR + LLM + TTS 多服务串联带来的延迟。
- 未使用 VAPI/Retell 这类商业 SaaS：它们上线快，但链路黑盒，不利于展示架构设计、工具调用、风控和数据层实现。
- 存储选择 SQLite：本地部署简单，支持结构化查询和索引，足够支撑 Demo；生产环境可替换为 PostgreSQL/MySQL。
- 微信通知选择 PushPlus：个人微信 Demo 接入成本低；生产环境可替换为企业微信机器人或企业微信 API。

## 功能

- 访客登记：自然对话采集车牌、单位、手机号、事由，字段齐全后调用 `submit_visit`。
- 25 秒目标：从 Agent 开始说话到微信消息发出计时，不包含拨号振铃时间。
- 回访识别：根据来电号码或车牌匹配历史访客，必须经用户确认后才复用历史记录。
- 风险兜底：对辱骂、威胁、硬闯、prompt injection 做清洗、记录或转人工。
- 门卫查询 Agent：支持“今天来了多少车”“本周哪个时间段最多”“某车牌最近一次什么时候来”等查询。

## 本地部署

```bash
npm install
copy .env.example .env
npm start
```

另开窗口暴露本地服务：

```bash
ngrok http 3000
```

将 ngrok HTTPS 地址填入 `.env`：

```env
PUBLIC_BASE_URL=https://your-ngrok-domain.ngrok-free.app
```

Twilio 控制台配置：

```text
访客登记号码 Voice webhook: https://your-ngrok-domain.ngrok-free.app/voice
门卫查询号码 Voice webhook: https://your-ngrok-domain.ngrok-free.app/guard-voice
```

## 环境变量

参考 `.env.example`：

```env
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=your_twilio_phone_number
GUARD_TWILIO_PHONE_NUMBER=your_guard_query_twilio_phone_number
OPENAI_API_KEY=your_openai_api_key
OPENAI_REALTIME_MODEL=gpt-realtime
PUSHPLUS_TOKEN=your_pushplus_token
PUSHPLUS_TOPIC=
PUBLIC_BASE_URL=https://your-ngrok-domain.ngrok-free.app
PORT=3000
HOST=0.0.0.0
GUARD_QUERY_TOKEN=
```

真实密钥只放 `.env`，不要提交 `.env`、`data/`、`logs/`。
