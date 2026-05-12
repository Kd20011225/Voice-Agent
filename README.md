# Voice Agent 访客登记 Demo

电话接入的 AI 门岗：访客拨打 Twilio 号码，OpenAI Realtime 用自然中文实时对话，采集车牌、来访单位、手机号和事由，随后通过 PushPlus 推送到保安个人微信。

## 架构

```text
访客手机
  |
  v
Twilio Voice Number
  |
  v
POST /voice -> <Connect><Stream>
  |
  v
Node.js /media WebSocket <-> OpenAI Realtime
  |
  +--> data/visitors.json 本地记录和回访识别
  +--> PushPlus 微信通知
```

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

把 ngrok 的 HTTPS 地址填入 `.env`：

```env
PUBLIC_BASE_URL=https://your-ngrok-domain.ngrok-free.app
```

重启 `npm start`，然后在 Twilio 控制台把号码的 Voice webhook 配成：

```text
https://your-ngrok-domain.ngrok-free.app/voice
```

## 环境变量

```env
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=your_twilio_phone_number
OPENAI_API_KEY=your_openai_api_key
OPENAI_REALTIME_MODEL=gpt-realtime
PUSHPLUS_TOKEN=your_pushplus_token
PUSHPLUS_TOPIC=
PUBLIC_BASE_URL=https://your-ngrok-domain.ngrok-free.app
PORT=3000
HOST=0.0.0.0
```

## 演示话术

```text
AI：您好，门岗。麻烦说下车牌号，找哪家公司，什么事儿？
用户：沪A12345，来蓝色鲸鱼科技送货的。
AI：收到，手机号方便留一下吗？请慢一点读。
用户：幺三八，幺二三四，幺一二三。
AI：好的，沪A12345，蓝色鲸鱼科技送货，已通知门卫，请稍等放行。
```

真实密钥只放 `.env`，不要提交 `.env`、`data/` 或 `logs/`。
