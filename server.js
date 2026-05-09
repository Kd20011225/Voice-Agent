import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import axios from 'axios';
import OpenAI from 'openai';
import twilio from 'twilio';

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const DB_FILE = join(DATA_DIR, 'visitors.json');
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN;
const PUSHPLUS_TOPIC = process.env.PUSHPLUS_TOPIC;
const PUSHPLUS_SEND_URL = 'https://www.pushplus.plus/send';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

let openai = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
} else {
  console.warn('WARN: OPENAI_API_KEY is not set. 无法调用 OpenAI 进行语音理解，系统将使用后备解析。');
}

mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(DB_FILE)) {
  writeFileSync(DB_FILE, JSON.stringify({ visitors: [] }, null, 2), 'utf8');
}

const VoiceResponse = twilio.twiml.VoiceResponse;
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Voice Agent Visitor Registration Demo is running.');
});

app.post('/voice', async (req, res) => {
  const transcript = (req.body.SpeechResult || '').trim();
  const callerPhone = normalizePhone(req.body.From || '');
  const queryState = parseState(req.query.state);
  const response = new VoiceResponse();

  try {
    if (!transcript) {
      const previous = callerPhone ? findPreviousVisitor({ phone: callerPhone }) : null;
      const state = previous ? encodeState({ returnCandidate: previous, callerPhone }) : '';
      const gather = response.gather({
        input: 'speech',
        language: 'cmn-Hans-CN',
        speechTimeout: 'auto',
        timeout: 4,
        action: state ? `/voice?state=${encodeURIComponent(state)}` : '/voice',
        method: 'POST'
      });

      gather.say({ language: 'zh-CN' }, buildOpeningPrompt(previous));
      response.say({ language: 'zh-CN' }, '不好意思，刚才没听见。您再说一遍就行。');
      return sendTwiml(res, response);
    }

    const result = await processTranscript(transcript, queryState, callerPhone);

    if (result.needsMore) {
      const nextState = encodeState({ partial: result.partial, callerPhone });
      const gather = response.gather({
        input: 'speech',
        language: 'cmn-Hans-CN',
        speechTimeout: 'auto',
        timeout: 4,
        action: `/voice?state=${encodeURIComponent(nextState)}`,
        method: 'POST'
      });
      gather.say({ language: 'zh-CN' }, result.prompt);
      response.say({ language: 'zh-CN' }, '我这边没收到声音，您再说一下。');
      return sendTwiml(res, response);
    }

    await saveVisit(result.final);
    await notifyGuard(result.final);
    response.say({ language: 'zh-CN' }, buildVoiceReply(result.final));

    return sendTwiml(res, response);
  } catch (error) {
    console.error('处理语音失败：', error?.message || error);
    response.say({ language: 'zh-CN' }, '不好意思，这边暂时没处理成功。麻烦您稍后再拨一次，或者联系门岗人工登记。');
    return sendTwiml(res, response);
  }
});

function sendTwiml(res, response) {
  res.type('text/xml');
  res.send(response.toString());
}

function parseState(stateString) {
  if (!stateString) return null;
  try {
    return JSON.parse(Buffer.from(stateString, 'base64').toString('utf8'));
  } catch (error) {
    return null;
  }
}

function encodeState(state) {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
}

function buildOpeningPrompt(previous) {
  if (previous) {
    return `您好，今天还是去${previous.company}${previous.reason}吗？如果不是，直接说车牌、公司和什么事儿就行。`;
  }
  return '您好，门岗。麻烦说下车牌号，今天找哪家公司，什么事儿？';
}

async function processTranscript(transcript, queryState, callerPhone) {
  if (queryState?.returnCandidate && isAffirmative(transcript)) {
    const previous = queryState.returnCandidate;
    const final = normalizeVisitor({
      license_plate: previous.license_plate,
      company: previous.company,
      phone: callerPhone || queryState.callerPhone || previous.phone,
      reason: previous.reason
    });
    final.is_returning = true;
    final.previous_summary = `沿用上次来访记录：${previous.company}，${previous.reason}`;
    return { needsMore: false, final };
  }

  const seed = queryState?.partial ? { ...queryState.partial } : {};

  const parsed = await parseVisitorSentence(transcript);
  const partial = mergeVisitor(seed, parsed);

  const missing = findMissingFields(partial);
  if (missing.length > 0) {
    return {
      needsMore: true,
      partial,
      prompt: buildFollowUpPrompt(missing)
    };
  }

  return { needsMore: false, final: normalizeVisitor(partial) };
}

function mergeVisitor(base, patch) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && String(value).trim()) {
      merged[key] = value;
    }
  }
  return merged;
}

function findMissingFields(visitor) {
  const needed = ['license_plate', 'company', 'phone', 'reason'];
  return needed.filter((key) => !visitor[key] || String(visitor[key]).trim().length === 0);
}

function buildFollowUpPrompt(fields) {
  const missing = Array.isArray(fields) ? fields : [fields];
  const labels = {
    license_plate: '车牌',
    company: '公司',
    phone: '手机号',
    reason: '事由'
  };
  const readable = missing.map((field) => labels[field]).filter(Boolean);

  if (readable.length === 0) {
    return '刚才这句我没听清，您再说一次。';
  }
  if (readable.length === 1) {
    const only = readable[0];
    if (only === '车牌') return '收到，还差车牌号。';
    if (only === '公司') return '收到，您今天找哪家公司？';
    if (only === '手机号') return '收到，手机号方便留一下吗？';
    return '收到，什么事儿过来？';
  }

  const last = readable.pop();
  return `收到，还差${readable.join('、')}和${last}，您一起说就行。`;
}

function buildVoiceReply(visitor) {
  if (visitor.is_returning) {
    return `好的，已按上次信息登记，${visitor.license_plate}，${visitor.company}${visitor.reason}，已通知门卫，请稍等。`;
  }
  return `好的，${visitor.license_plate}，${visitor.company}${visitor.reason}，已通知门卫，请稍等放行。`;
}

function isAffirmative(text) {
  return /^(对|是|嗯|恩|好|可以|没错|还是|老地方|一样|对对|对的)/.test(text.trim());
}

function formatTimestamp(ts) {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

async function parseVisitorSentence(sentence) {
  if (!OPENAI_API_KEY) {
    return fallbackParse(sentence);
  }

  const prompt = `你是工业园区门岗的语音信息提取器。用户会用自然口语说明车牌、来访公司、来访事由、手机号。请只返回 JSON，不要输出解释。

文本："${sentence}"

字段：
- license_plate: 车牌号，没有则为空字符串
- company: 来访公司，没有则为空字符串
- phone: 手机号，没有则为空字符串
- reason: 来访事由，没有则为空字符串

注意：
- "来蓝色鲸鱼送货" 中 company 是 "蓝色鲸鱼"，reason 是 "送货"。
- "去星河科技维修" 中 company 是 "星河科技"，reason 是 "维修"。
- 不要把寒暄、"我车牌是"、"手机号" 等提示词放进 company。`;

  try {
    const completion = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: prompt,
      max_output_tokens: 250,
    });

    const raw = completion.output?.[0]?.content?.[0]?.text ?? '';
    const jsonText = extractJson(raw);
    return {
      license_plate: jsonText.license_plate || '',
      company: jsonText.company || '',
      phone: jsonText.phone || '',
      reason: jsonText.reason || ''
    };
  } catch (error) {
    console.warn('OpenAI 解析失败，使用后备解析。', error?.message || error);
    return fallbackParse(sentence);
  }
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('无法找到 JSON');
  return JSON.parse(match[0]);
}

function fallbackParse(sentence) {
  const result = {
    license_plate: '',
    company: '',
    phone: '',
    reason: ''
  };
  const phoneMatch = sentence.match(/1\d{10}/);
  if (phoneMatch) result.phone = phoneMatch[0];

  const plateMatch = sentence.toUpperCase().match(/[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z0-9][A-Z0-9]{4,5}/u);
  if (plateMatch) result.license_plate = plateMatch[0].trim();

  const commonReasons = ['送材料', '送货', '拜访', '面试', '维修', '取货', '开会', '安装'];
  for (const reason of commonReasons) {
    if (sentence.includes(reason)) {
      result.reason = reason;
      break;
    }
  }

  const companyMatch = sentence.match(/[去到来找]([^，。,. ]{2,20}?)(送材料|送货|拜访|面试|维修|取货|开会|安装|的|$)/);
  if (companyMatch) {
    let company = companyMatch[1]
      .replace(/^(公司|单位)/, '')
      .replace(/手机号.*$/, '')
      .replace(/[的地]$/, '')
      .trim();
    for (const reason of commonReasons) {
      company = company.replace(reason, '').trim();
    }
    result.company = company;
  }

  return result;
}

function normalizeVisitor(visitor) {
  const now = new Date();
  const record = {
    license_plate: (visitor.license_plate || '').replace(/\s+/g, '').toUpperCase(),
    company: (visitor.company || '').trim(),
    phone: normalizePhone(visitor.phone || ''),
    reason: (visitor.reason || '').trim(),
    visited_at: now.toISOString(),
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
    const text = readFileSync(DB_FILE, 'utf8');
    return JSON.parse(text);
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

  const payload = {
    token: PUSHPLUS_TOKEN,
    title,
    content,
    template: 'markdown'
  };
  if (PUSHPLUS_TOPIC) payload.topic = PUSHPLUS_TOPIC;

  const response = await axios.post(PUSHPLUS_SEND_URL, payload, {
    headers: { 'Content-Type': 'application/json' }
  });
  if (response.data?.code && response.data.code !== 200) {
    throw new Error(`PushPlus 推送失败：${response.data.msg || response.data.code}`);
  }
}

app.listen(PORT, HOST, () => {
  console.log(`Voice Agent server listening at http://${HOST}:${PORT}`);
  if (TWILIO_PHONE_NUMBER) {
    console.log(`Twilio phone number: ${TWILIO_PHONE_NUMBER}`);
  }
});
