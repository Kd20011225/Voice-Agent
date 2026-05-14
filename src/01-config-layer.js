import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

loadEnv();

const rootDir = dirname(fileURLToPath(new URL('../server.js', import.meta.url)));

export const appConfig = {
  rootDir,
  dataDir: join(rootDir, 'data'),
  dbFile: join(rootDir, 'data', 'visitors.sqlite'),
  legacyJsonDbFile: join(rootDir, 'data', 'visitors.json'),
  port: process.env.PORT || 3000,
  host: process.env.HOST || '0.0.0.0',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiRealtimeModel: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
  guardTwilioPhoneNumber: process.env.GUARD_TWILIO_PHONE_NUMBER || '',
  guardQueryToken: process.env.GUARD_QUERY_TOKEN || '',
  pushplusToken: process.env.PUSHPLUS_TOKEN || '',
  pushplusTopic: process.env.PUSHPLUS_TOPIC || '',
  pushplusSendUrl: 'https://www.pushplus.plus/send'
};
