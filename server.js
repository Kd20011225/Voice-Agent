import { appConfig } from './src/01-config-layer.js';
import { createInfrastructure } from './src/02-infrastructure-layer.js';
import { createVisitorService } from './src/03-visitor-domain-layer.js';
import { createVoiceGateway } from './src/05-voice-gateway-layer.js';

const infrastructure = createInfrastructure(appConfig);
const visitorService = createVisitorService(infrastructure);
const { server } = createVoiceGateway(appConfig, visitorService);

if (!appConfig.openaiApiKey) {
  console.warn('WARN: OPENAI_API_KEY is not set. Realtime and fallback parsing will not work.');
}

server.listen(appConfig.port, appConfig.host, () => {
  console.log(`Voice Agent Realtime server listening at http://${appConfig.host}:${appConfig.port}`);
  if (appConfig.twilioPhoneNumber) console.log(`Twilio phone number: ${appConfig.twilioPhoneNumber}`);
  if (appConfig.guardTwilioPhoneNumber) console.log(`Guard query Twilio phone number: ${appConfig.guardTwilioPhoneNumber}`);
  if (appConfig.publicBaseUrl) console.log(`Public base URL: ${appConfig.publicBaseUrl}`);
});
