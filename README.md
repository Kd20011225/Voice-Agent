# Voice Agent 访客登记 Demo

电话接入的 AI 门岗：访客拨打 Twilio 号码，Agent 用自然中文采集车牌、来访单位、手机号和事由，登记本地记录，并通过 PushPlus 推送到个人微信。

## 架构

```text
访客手机
  |
  v
Twilio Voice Number
  |
  v
POST /voice  本地 Node.js/Express
  |
  +--> Twilio Gather/Say：中文语音对话
  +--> OpenAI：从自然表达中提取访客字段
  +--> data/visitors.json：本地访客记录和回访识别
  |
  v
PushPlus 微信公众号 --> 保安个人微信
```

## 本地部署

```bash
npm install
copy .env.example .env
npm start
```

另开窗口暴露本地服务：

```bash
npx ngrok http 3000
```

在 Twilio 控制台把号码的 Voice webhook 配成：

```text
https://<你的-ngrok域名>/voice
```

然后用手机拨打 Twilio 号码，按自然口语一次说完即可，例如：

```text
你好，我车牌是沪A12345，去星河科技，手机号一三八一二三四五六七八，过来送货。
```

## 环境变量

```env
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=your_twilio_phone_number
OPENAI_API_KEY=your_openai_api_key
PUSHPLUS_TOKEN=your_pushplus_token
PUSHPLUS_TOPIC=
PORT=3000
HOST=0.0.0.0
```

`PUSHPLUS_TOKEN` 获取方式：微信登录 PushPlus，关注 PushPlus 公众号，在后台复制 Token。`PUSHPLUS_TOPIC` 可留空，留空时只推送给自己。

## 演示验收

- 全链路：电话接通 -> Agent 采集信息 -> 微信收到完整访客通知。
- 时长：建议用户一次说完四项信息，目标从 Agent 开口到微信推送小于 25 秒。
- 体验：缺字段时一次性补问缺失项，避免机械式逐项问答。
- 安全：真实密钥只放 `.env`，不要提交 `.env` 或 `data/`。
