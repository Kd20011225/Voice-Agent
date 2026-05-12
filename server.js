import express from 'express';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import axios from 'axios';
import OpenAI from 'openai';
import twilio from 'twilio';
import WebSocket, { WebSocketServer } from 'ws';

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const DB_FILE = join(DATA_DIR, 'visitors.json');
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN;
const PUSHPLUS_TOPIC = process.env.PUSHPLUS_TOPIC;
const PUSHPLUS_SEND_URL = 'https://www.pushplus.plus/send';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

let openai = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
} else {
  console.warn('WARN: OPENAI_API_KEY is not set. Realtime and fallback parsing will not work.');
}

mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(DB_FILE)) {
  writeFileSync(DB_FILE, JSON.stringify({ visitors: [] }, null, 2), 'utf8');
}

const VoiceResponse = twilio.twiml.VoiceResponse;
const app = express();
const server = createServer(app);
const mediaWss = new WebSocketServer({ noServer: true });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Voice Agent Realtime Visitor Registration Demo is running.');
});

app.post('/voice', (req, res) => {
  const response = new VoiceResponse();
  const connect = response.connect();
  const stream = connect.stream({
    url: buildMediaStreamUrl(req),
    name: 'voice-agent-realtime'
  });
  stream.parameter({ name: 'callerPhone', value: req.body.From || '' });
  sendTwiml(res, response);
});

// Minimal fallback route if you want to temporarily switch Twilio away from Realtime.
app.post('/voice-gather', async (req, res) => {
  const response = new VoiceResponse();
  response.say({ language: 'zh-CN', voice: 'alice' }, '您好，门岗。Realtime 模式未启用，请稍后再试。');
  sendTwiml(res, response);
});

function sendTwiml(res, response) {
  res.type('text/xml');
  res.send(response.toString());
}

function buildMediaStreamUrl(req) {
  const base = PUBLIC_BASE_URL || `https://${req.headers.host}`;
  return base.replace(/^http/i, 'ws').replace(/\/$/, '') + '/media';
}

server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/media')) {
    mediaWss.handleUpgrade(req, socket, head, (ws) => {
      mediaWss.emit('connection', ws, req);
    });
    return;
  }
  socket.destroy();
});

mediaWss.on('connection', (twilioWs) => {
  if (!OPENAI_API_KEY) {
    twilioWs.close();
    return;
  }

  let streamSid = null;
  let callerPhone = '';
  let latestVisitor = {};
  let openaiReady = false;
  let greetingSent = false;
  let callClosed = false;

  const openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  openaiWs.on('open', () => {
    openaiReady = true;
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: buildRealtimeInstructions(),
        voice: 'alloy',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'gpt-4o-transcribe',
          language: 'zh'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.45,
          prefix_padding_ms: 300,
          silence_duration_ms: 550,
          create_response: true,
          interrupt_response: true
        },
        tools: [
          {
            type: 'function',
            name: 'submit_visit',
            description: 'Save a completed visitor registration and notify the guard on WeChat.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                license_plate: { type: 'string', description: 'Chinese vehicle license plate, e.g. 沪A12345' },
                company: { type: 'string', description: 'Target company in the park' },
                phone: { type: 'string', description: 'Visitor phone number, 11 Chinese mobile digits when possible' },
                reason: { type: 'string', description: 'Visit reason, e.g. 送货, 拜访, 面试, 维修' }
              },
              required: ['license_plate', 'company', 'phone', 'reason']
            }
          }
        ],
        tool_choice: 'auto',
        temperature: 0.7,
        max_response_output_tokens: 700
      }
    }));
  });

  twilioWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || msg.streamSid;
      callerPhone = normalizePhone(msg.start?.customParameters?.callerPhone || '');
      latestVisitor = callerPhone ? { phone: callerPhone } : {};
      maybeSendGreeting();
      return;
    }

    if (msg.event === 'media' && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: msg.media.payload
      }));
      return;
    }

    if (msg.event === 'stop') {
      callClosed = true;
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    }
  });

  openaiWs.on('message', async (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (event.type === 'session.updated' || event.type === 'session.created') {
      maybeSendGreeting();
      return;
    }

    if ((event.type === 'response.output_audio.delta' || event.type === 'response.audio.delta') && event.delta && streamSid && twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: event.delta }
      }));
      return;
    }

    if ((event.type === 'response.output_audio.done' || event.type === 'response.audio.done') && streamSid && twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify({
        event: 'mark',
        streamSid,
        mark: { name: `response-${Date.now()}` }
      }));
      return;
    }

    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const parsed = fallbackParse(event.transcript || '');
      latestVisitor = mergeVisitor(latestVisitor, parsed);
      return;
    }

    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      await handleFunctionCall(event.item);
      return;
    }

    if (event.type === 'response.function_call_arguments.done' && event.name === 'submit_visit') {
      await handleFunctionCall({
        name: event.name,
        call_id: event.call_id,
        arguments: event.arguments
      });
      return;
    }

    if (event.type === 'error') {
      console.error('OpenAI Realtime error:', event.error?.message || event);
    }
  });

  openaiWs.on('close', () => {
    if (!callClosed && twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  openaiWs.on('error', (error) => {
    console.error('OpenAI Realtime socket error:', error.message);
  });

  twilioWs.on('close', () => {
    callClosed = true;
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  function maybeSendGreeting() {
    if (!openaiReady || !streamSid || greetingSent || openaiWs.readyState !== WebSocket.OPEN) return;
    greetingSent = true;
    const previous = callerPhone ? findPreviousVisitor({ phone: callerPhone }) : null;
    const greeting = previous
      ? `请用中文自然地说：您好，今天还是去${previous.company}${previous.reason}吗？如果不是，直接说车牌、公司和什么事儿就行。`
      : '请用中文自然地说：您好，门岗。麻烦说下车牌号，找哪家公司，什么事儿？';

    if (previous) latestVisitor = mergeVisitor(latestVisitor, previous);
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: greeting
      }
    }));
  }

  async function handleFunctionCall(item) {
    let args = {};
    try {
      args = JSON.parse(item.arguments || '{}');
    } catch {
      args = {};
    }

    const final = normalizeVisitor(mergeVisitor(latestVisitor, args));
    const missing = findMissingFields(final);
    if (missing.length > 0) {
      sendFunctionResult(item.call_id, { ok: false, missing });
      openaiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio', 'text'],
          instructions: `还缺这些字段：${missing.join(', ')}。请只追问缺失的信息，语气像真人门卫，简短。`
        }
      }));
      return;
    }

    await saveVisit(final);
    await notifyGuard(final);
    sendFunctionResult(item.call_id, { ok: true, visitor: final });
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: `请简短确认：好的，${final.license_plate}，${final.company}${final.reason}，已通知门卫，请稍等放行。`
      }
    }));
  }

  function sendFunctionResult(callId, output) {
    openaiWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(output)
      }
    }));
  }
});

function buildRealtimeInstructions() {
  return `你是工业园区停车场入口的真人门卫语音助手。目标是在 25 秒内自然采集访客信息，并通知门卫。

必须采集字段：
1. 车牌号，例如 沪A12345。
2. 来访单位，例如 蓝色鲸鱼科技。
3. 手机号，例如 13812341234。
4. 来访事由，例如 送货、拜访、面试、维修。

对话规则：
- 全程中文，像真人门卫，简短自然。
- 不要机械地一项一项问。先让用户一次说车牌、公司、事由。
- 如果只缺手机号，只问：手机号方便留一下吗？请慢一点读。
- 用户说手机号时，要能理解“一/幺/一三八/幺三八”等中文数字读法。
- 车牌、公司、事由、手机号都拿齐后，立刻调用 submit_visit。
- 调用 submit_visit 前不要说已经通知门卫。
- 不要询问预计停留多久。
- 如果用户说“对，还是老地方”，且已有历史信息，就沿用历史信息并调用 submit_visit。`;
}

function mergeVisitor(base, patch) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && String(value).trim()) merged[key] = value;
  }
  return merged;
}

function findMissingFields(visitor) {
  const needed = ['license_plate', 'company', 'phone', 'reason'];
  return needed.filter((key) => !visitor[key] || String(visitor[key]).trim().length === 0);
}

function formatTimestamp(ts) {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function fallbackParse(sentence) {
  const result = { license_plate: '', company: '', phone: '', reason: '' };
  const text = String(sentence || '');
  const phoneMatch = text.match(/1\d{10}/);
  if (phoneMatch) result.phone = phoneMatch[0];
  if (!result.phone) result.phone = parseSpokenPhone(text);

  const plateMatch = text.toUpperCase().match(/[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z0-9][A-Z0-9]{4,5}/u);
  if (plateMatch) result.license_plate = plateMatch[0].trim();

  const commonReasons = ['送材料', '送货', '拜访', '面试', '维修', '取货', '开会', '安装'];
  for (const reason of commonReasons) {
    if (text.includes(reason)) {
      result.reason = reason;
      break;
    }
  }

  const companyMatch = text.match(/[去到来找]([^，。,. ]{2,20}?)(送材料|送货|拜访|面试|维修|取货|开会|安装|的|$)/);
  if (companyMatch) {
    let company = companyMatch[1].replace(/^(公司|单位)/, '').replace(/手机号.*$/, '').replace(/[的地]$/, '').trim();
    for (const reason of commonReasons) company = company.replace(reason, '').trim();
    result.company = company;
  }

  return result;
}

function parseSpokenPhone(text) {
  const digitMap = {
    零: '0', 〇: '0', 洞: '0',
    一: '1', 幺: '1',
    二: '2', 两: '2',
    三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9'
  };
  const digits = Array.from(String(text || '')).map((char) => /\d/.test(char) ? char : (digitMap[char] || '')).join('');
  const match = digits.match(/1\d{10}/);
  return match ? match[0] : '';
}

function normalizeVisitor(visitor) {
  const record = {
    license_plate: (visitor.license_plate || '').replace(/\s+/g, '').toUpperCase(),
    company: (visitor.company || '').trim(),
    phone: normalizePhone(visitor.phone || ''),
    reason: (visitor.reason || '').trim(),
    visited_at: new Date().toISOString(),
    is_returning: false,
    previous_summary: ''
  };

  const previous = findPreviousVisitor(record);
  if (previous) {
    record.is_returning = true;
    record.previous_summary = `上次于 ${formatTimestamp(previous.visited_at)} 来访 ${previous.company}，事由：${previous.reason}`;
  }
  return record;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^0-9]/g, '').slice(-11);
}

function findPreviousVisitor(visitor) {
  const phone = normalizePhone(visitor.phone || '');
  const licensePlate = (visitor.license_plate || '').replace(/\s+/g, '').toUpperCase();
  const history = loadVisitors();
  return history.visitors.find((item) => {
    const samePhone = phone && normalizePhone(item.phone) === phone;
    const samePlate = licensePlate && item.license_plate === licensePlate;
    return samePhone || samePlate;
  });
}

function loadVisitors() {
  try {
    return JSON.parse(readFileSync(DB_FILE, 'utf8'));
  } catch (error) {
    console.warn('读取访客数据失败，重新初始化。', error?.message || error);
    return { visitors: [] };
  }
}

async function saveVisit(visitor) {
  const db = loadVisitors();
  db.visitors.unshift(visitor);
  if (db.visitors.length > 200) db.visitors = db.visitors.slice(0, 200);
  writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

async function notifyGuard(visitor) {
  const title = '访客登记通知';
  const content = [
    `**车牌：** ${visitor.license_plate}`,
    `**来访单位：** ${visitor.company}`,
    `**来访事由：** ${visitor.reason}`,
    `**手机：** ${visitor.phone}`,
    `**入场时间：** ${formatTimestamp(visitor.visited_at)}`,
    visitor.is_returning ? `**回访记录：** ${visitor.previous_summary}` : ''
  ].filter(Boolean).join('\n\n');

  if (!PUSHPLUS_TOKEN) {
    console.log('[个人微信通知模拟] ' + title + '\n' + content);
    return;
  }

  const payload = { token: PUSHPLUS_TOKEN, title, content, template: 'markdown' };
  if (PUSHPLUS_TOPIC) payload.topic = PUSHPLUS_TOPIC;

  const response = await axios.post(PUSHPLUS_SEND_URL, payload, {
    headers: { 'Content-Type': 'application/json' }
  });
  if (response.data?.code && response.data.code !== 200) {
    throw new Error(`PushPlus 推送失败：${response.data.msg || response.data.code}`);
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Voice Agent Realtime server listening at http://${HOST}:${PORT}`);
  if (TWILIO_PHONE_NUMBER) console.log(`Twilio phone number: ${TWILIO_PHONE_NUMBER}`);
  if (PUBLIC_BASE_URL) console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
});
