import { createServer, getServerPort } from "@devvit/web/server";
import { serverOnRequest } from "./server.ts";
import { Devvit } from '@devvit/public-api';

Devvit.configure({
  redis: true,
  redditAPI: true,
  kvStore: true,
  media: true,
});

Devvit.addSettings([
  {
    type: 'string',
    name: 'ai_api_key',
    label: 'API_KEY',
  },
  {
    type: 'select',
    name: 'ai_mode',
    label: 'MODE',
    options: [
      { label: 'Off', value: 'off' },
      { label: 'Assistant', value: 'assistant' },
      { label: 'Surrogate', value: 'surrogate' }
    ],
    defaultValue: ['off'],
  },
  {
    type: 'number',
    name: 'crisis_threshold',
    label: 'Crisis Threshold (Hours)',
    defaultValue: 1,
  },
  {
    type: 'select',
    name: 'surgical_mode',
    label: 'Override Status',
    options: [
      { label: 'Auto (Heartbeat)', value: 'auto' },
      { label: 'Force Stable', value: 'stable' },
      { label: 'Force Crisis', value: 'crisis' }
    ],
    defaultValue: ['auto'],
  }
]);

// Triggers are handled via the web server mapping in devvit.json
// to avoid duplication and keep logic in one place (server.ts).

const server = createServer((req, res) => {
  console.log(`[DR. Mod] WEB REQUEST: ${req.url}`);
  return serverOnRequest(req, res);
});
const port: number = getServerPort();
server.on("error", (err) => console.error(`server error; ${err.stack}`));
server.listen(port);

export default Devvit;
