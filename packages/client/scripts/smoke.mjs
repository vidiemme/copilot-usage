// Smoke test manuale: mock upstream stile CAPI + proxy reale, senza collector.
// Uso: node scripts/smoke.mjs
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const UPSTREAM_PORT = 9911;
const PROXY_PORT = 9912;

let received = null;

const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received = {
      url: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'),
    };

    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req-smoke-1' });
    res.write('data: {"model":"gpt-5.4","choices":[{"delta":{"content":"ciao"}}]}\n\n');
    res.write(
      'data: {"model":"gpt-5.4","choices":[],"usage":{"prompt_tokens":10000,"completion_tokens":500,"prompt_tokens_details":{"cached_tokens":8000}}}\n\n',
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, resolve));

process.env.UPSTREAM_BASE_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
// Nessun collector in ascolto: e' voluto. Lo smoke test verifica che il
// percorso proxy funzioni anche quando la raccolta e' irraggiungibile.
process.env.COLLECTOR_URL = 'http://127.0.0.1:1/v1/usage';
process.env.COLLECTOR_TOKEN = 'x'.repeat(32);
process.env.SPOOL_PATH = join(tmpdir(), `smoke-spool-${process.pid}.jsonl`);
process.env.DEVELOPER_ID_SALT = 'smoke-salt';
process.env.PORT = String(PROXY_PORT);
process.env.LOG_LEVEL ??= 'silent';

const { loadConfig } = await import('../dist/config.js');
const { buildApp } = await import('../dist/server.js');

const app = await buildApp(loadConfig());
await app.server.listen({ port: PROXY_PORT, host: '127.0.0.1' });

const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/p/acme-portal/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer ghu_finto',
    'accept-encoding': 'gzip, br',
    'user-agent': 'GitHubCopilotChat/1.0',
  },
  body: JSON.stringify({ model: 'gpt-5.4', stream: true, messages: [{ role: 'user', content: 'ciao' }] }),
});

let body = '';
for await (const chunk of response.body) body += Buffer.from(chunk).toString('utf-8');

if (!received) {
  console.error(`L'upstream non ha ricevuto nulla. Stato: ${response.status}. Corpo: ${body}`);
  await app.close().catch(() => {});
  upstream.close();
  process.exit(1);
}

const checks = {
  'path ripulito dal prefisso progetto': received.url === '/chat/completions',
  'accept-encoding forzato a identity': received.headers['accept-encoding'] === 'identity',
  'host riscritto': received.headers.host === `127.0.0.1:${UPSTREAM_PORT}`,
  'authorization inoltrato': received.headers.authorization === 'Bearer ghu_finto',
  'stream_options iniettato': received.body.stream_options?.include_usage === true,
  'stato 200': response.status === 200,
  'content-type SSE preservato': response.headers.get('content-type') === 'text/event-stream',
  'stream inoltrato intatto': body.includes('"content":"ciao"') && body.includes('[DONE]'),
};

for (const [label, ok] of Object.entries(checks)) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
}

await delay(100);
await app.close().catch(() => {});
upstream.close();
rmSync(process.env.SPOOL_PATH, { force: true });

process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
