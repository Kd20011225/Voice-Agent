import express from 'express';
import { createServer } from 'http';
import twilio from 'twilio';
import WebSocket, { WebSocketServer } from 'ws';
import { createDialogueSession, buildRealtimeInstructions, submitVisitToolDefinition } from './04-dialogue-flow-layer.js';

const VoiceResponse = twilio.twiml.VoiceResponse;

export function createVoiceGateway(config, visitorService) {
  const app = express();
  const server = createServer(app);
  const mediaWss = new WebSocketServer({ noServer: true });
  const guardMediaWss = new WebSocketServer({ noServer: true });

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.get('/', (req, res) => {
    res.send('Voice Agent Realtime Visitor Registration Demo is running.');
  });

  app.post('/voice', (req, res) => {
    const response = new VoiceResponse();
    const connect = response.connect();
    const stream = connect.stream({
      url: buildMediaStreamUrl(config, req),
      name: 'voice-agent-realtime'
    });
    stream.parameter({ name: 'callerPhone', value: req.body.From || '' });
    sendTwiml(res, response);
  });

  app.post('/voice-gather', async (req, res) => {
    const response = new VoiceResponse();
    response.say({ language: 'zh-CN', voice: 'alice' }, '您好，门岗。Realtime 模式未启用，请稍后再试。');
    sendTwiml(res, response);
  });

  app.post('/guard-voice', (req, res) => {
    const response = new VoiceResponse();
    const connect = response.connect();
    const stream = connect.stream({
      url: buildMediaStreamUrl(config, req, '/guard-media'),
      name: 'guard-query-realtime'
    });
    stream.parameter({ name: 'callerPhone', value: req.body.From || '' });
    sendTwiml(res, response);
  });

  app.post('/guard/query', (req, res) => {
    if (!isGuardQueryAuthorized(config, req)) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    const question = req.body?.question || req.body?.q || '';
    const result = visitorService.answerGuardQuery(question);
    res.json({ ok: true, question, ...result });
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/guard-media')) {
      guardMediaWss.handleUpgrade(req, socket, head, (ws) => {
        guardMediaWss.emit('connection', ws, req);
      });
      return;
    }
    if (req.url?.startsWith('/media')) {
      mediaWss.handleUpgrade(req, socket, head, (ws) => {
        mediaWss.emit('connection', ws, req);
      });
      return;
    }
    socket.destroy();
  });

  mediaWss.on('connection', (twilioWs) => {
    if (!config.openaiApiKey) {
      twilioWs.close();
      return;
    }

    const dialogue = createDialogueSession(visitorService);
    let streamSid = null;
    let openaiReady = false;
    let greetingSent = false;
    let callClosed = false;

    const openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.openaiRealtimeModel)}`, {
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`
      }
    });

    openaiWs.on('open', () => {
      openaiReady = true;
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: config.openaiRealtimeModel,
          output_modalities: ['audio'],
          instructions: buildRealtimeInstructions(),
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              transcription: {
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
              }
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: 'alloy'
            }
          },
          tools: [submitVisitToolDefinition()],
          tool_choice: 'auto'
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
        dialogue.setCallerPhone(msg.start?.customParameters?.callerPhone || '');
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
        const action = await dialogue.handleTranscript(event.transcript || '');
        if (action.kind === 'prompt') sendAssistantInstruction(action.instruction);
        if (action.kind === 'risk_handoff') sendAssistantInstruction(action.instruction);
        if (action.kind === 'confirmed_return') {
          const result = await dialogue.handleSubmitVisit(null, '{}');
          if (result.instruction) sendAssistantInstruction(result.instruction);
        }
        return;
      }

      if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
        await handleFunctionCall(event.item.call_id, event.item.arguments);
        return;
      }

      if (event.type === 'response.function_call_arguments.done' && event.name === 'submit_visit') {
        await handleFunctionCall(event.call_id, event.arguments);
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

    async function handleFunctionCall(callId, rawArguments) {
      const result = await dialogue.handleSubmitVisit(callId, rawArguments);
      if (result.kind === 'duplicate') return;

      sendFunctionResult(callId, result.output || { ok: false });
      if (result.instruction) sendAssistantInstruction(result.instruction);
    }

    function maybeSendGreeting() {
      if (!openaiReady || !streamSid || greetingSent || openaiWs.readyState !== WebSocket.OPEN) return;
      greetingSent = true;
      sendAssistantInstruction(dialogue.greetingInstruction());
    }

    function sendAssistantInstruction(instruction) {
      if (openaiWs.readyState !== WebSocket.OPEN) return;
      openaiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          output_modalities: ['audio'],
          instructions: instruction
        }
      }));
    }

    function sendFunctionResult(callId, output) {
      if (!callId || openaiWs.readyState !== WebSocket.OPEN) return;
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

  guardMediaWss.on('connection', (twilioWs) => {
    if (!config.openaiApiKey) {
      twilioWs.close();
      return;
    }

    let streamSid = null;
    let openaiReady = false;
    let greetingSent = false;
    let callClosed = false;
    const handledFunctionCalls = new Set();

    const openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.openaiRealtimeModel)}`, {
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`
      }
    });

    openaiWs.on('open', () => {
      openaiReady = true;
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: config.openaiRealtimeModel,
          output_modalities: ['audio'],
          instructions: buildGuardQueryInstructions(),
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              transcription: {
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
              }
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: 'alloy'
            }
          },
          tools: [guardQueryToolDefinition()],
          tool_choice: 'auto'
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
        maybeSendGuardGreeting();
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
        maybeSendGuardGreeting();
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
          mark: { name: `guard-response-${Date.now()}` }
        }));
        return;
      }

      if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
        await handleGuardFunctionCall(event.item.call_id, event.item.arguments);
        return;
      }

      if (event.type === 'response.function_call_arguments.done' && event.name === 'answer_guard_query') {
        await handleGuardFunctionCall(event.call_id, event.arguments);
        return;
      }

      if (event.type === 'error') {
        console.error('OpenAI Guard Realtime error:', event.error?.message || event);
      }
    });

    openaiWs.on('close', () => {
      if (!callClosed && twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    });

    openaiWs.on('error', (error) => {
      console.error('OpenAI Guard Realtime socket error:', error.message);
    });

    twilioWs.on('close', () => {
      callClosed = true;
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    });

    async function handleGuardFunctionCall(callId, rawArguments) {
      if (callId && handledFunctionCalls.has(callId)) return;
      if (callId) handledFunctionCalls.add(callId);

      let args = {};
      try {
        args = JSON.parse(rawArguments || '{}');
      } catch {
        args = {};
      }

      const question = visitorService.sanitizeTranscript(args.question || '');
      const result = visitorService.answerGuardQuery(question);
      sendGuardFunctionResult(callId, { ok: true, question, answer: result.answer, data: result.data });
      sendGuardInstruction(`请用中文自然地回答保安：${result.answer}`);
    }

    function maybeSendGuardGreeting() {
      if (!openaiReady || !streamSid || greetingSent || openaiWs.readyState !== WebSocket.OPEN) return;
      greetingSent = true;
      sendGuardInstruction('请用中文自然地说：门卫查询助手，请问您要查什么？比如本周来了多少车，或者哪个时间段访问最多。');
    }

    function sendGuardInstruction(instruction) {
      if (openaiWs.readyState !== WebSocket.OPEN) return;
      openaiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          output_modalities: ['audio'],
          instructions: instruction
        }
      }));
    }

    function sendGuardFunctionResult(callId, output) {
      if (!callId || openaiWs.readyState !== WebSocket.OPEN) return;
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

  return { app, server };
}

function sendTwiml(res, response) {
  res.type('text/xml');
  res.send(response.toString());
}

function buildMediaStreamUrl(config, req, path = '/media') {
  const base = config.publicBaseUrl || `https://${req.headers.host}`;
  return base.replace(/^http/i, 'ws').replace(/\/$/, '') + path;
}

function isGuardQueryAuthorized(config, req) {
  if (!config.guardQueryToken) return true;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const headerToken = req.headers['x-guard-token'] || '';
  return bearer === config.guardQueryToken || headerToken === config.guardQueryToken;
}

function buildGuardQueryInstructions() {
  return `你是门卫查询语音助手，只回答访客记录统计问题。

规则：
- 全程中文，简短自然。
- 保安问访问量、访问高峰、某车牌最近记录、某公司或某访客访问次数时，调用 answer_guard_query。
- 支持按访客称呼查询，例如：张先生本周来了几次，王师傅最近一次什么时候来。
- 不要编造数据，必须以工具返回为准。
- 不要透露手机号全号，工具返回如有脱敏信息就按脱敏信息说。
- 如果问题和访客记录无关，就说：我只能查询访客登记记录。`;
}

function guardQueryToolDefinition() {
  return {
    type: 'function',
    name: 'answer_guard_query',
    description: 'Answer guard questions about visitor records and traffic statistics.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: {
          type: 'string',
          description: 'The guard natural language query, e.g. 本周一共多少访问车辆, 什么时间段访问最多'
        }
      },
      required: ['question']
    }
  };
}
