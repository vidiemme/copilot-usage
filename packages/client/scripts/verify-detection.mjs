// Verifica end-to-end del rilevamento automatico del progetto.
// Simula due finestre VS Code aperte su due repository diversi, con la stessa
// identica configurazione lato editor, e controlla cosa arriva al collector.
// Non serve un database: il client non ne ha piu' bisogno.
// Uso: node scripts/verify-detection.mjs
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const UPSTREAM_PORT = 9931;
const PROXY_PORT = 9932;
const COLLECTOR_PORT = 9933;
const COLLECTOR_TOKEN = 'a'.repeat(32);
const CLIENT = 'verify-detection';

const root = mkdtempSync(join(tmpdir(), 'verify-detection-'));

// Cartelle locali dal nome arbitrario, come dopo un clone qualsiasi: il
// progetto deve venire dal remote Git, non da come le ha chiamate il developer.
function makeRepo(folder, remoteUrl) {
  const gitDir = join(root, folder, '.git');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'config'), `[remote "origin"]\n\turl = ${remoteUrl}\n`);
}

makeRepo('cartella-a-caso', 'git@gitlab.com:acme/web/portal.git');
makeRepo('crm-locale', 'https://github.com/acme/legacy-crm.git');

let counter = 0;
const upstream = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': `${CLIENT}-${++counter}`,
    });
    res.write(
      'data: {"model":"gpt-5.4","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":100}}\n\n',
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, resolve));

// Collector finto: registra cio' che il client dichiara di aver misurato.
const received = [];
const collector = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (req.headers.authorization !== `Bearer ${COLLECTOR_TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    received.push(...JSON.parse(Buffer.concat(chunks).toString()).events);
    res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":true}');
  });
});
await new Promise((resolve) => collector.listen(COLLECTOR_PORT, resolve));

process.env.UPSTREAM_BASE_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
process.env.COLLECTOR_URL = `http://127.0.0.1:${COLLECTOR_PORT}/v1/usage`;
process.env.COLLECTOR_TOKEN = COLLECTOR_TOKEN;
process.env.SPOOL_PATH = join(root, 'spool.jsonl');
process.env.DEVELOPER_ID_SALT = 'verify-salt';
process.env.WORKSPACE_ROOTS = root;
process.env.PORT = String(PROXY_PORT);
process.env.LOG_LEVEL ??= 'silent';

const { loadConfig } = await import('../dist/config.js');
const { buildApp } = await import('../dist/server.js');

const config = loadConfig();
const app = await buildApp(config);
await app.server.listen({ port: PROXY_PORT, host: '127.0.0.1' });

/** Nessun progetto nell'URL: la configurazione e' identica per ogni finestra. */
async function ask(windowId, content) {
  const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer tid=abc123;u=99887;exp=1784990000',
      'vscode-sessionid': windowId,
      'user-agent': CLIENT,
    },
    body: JSON.stringify({
      model: 'gpt-5.4',
      stream: true,
      messages: [{ role: 'user', content }],
    }),
  });
  for await (const chunk of response.body) void chunk;
}

// Finestra 1: lavora su portal. Finestra 2: su legacy-crm. In parallelo.
await ask('window-1', `Perche' fallisce ${root}/cartella-a-caso/src/index.ts?`);
await ask('window-2', `Rivedi ${root}/crm-locale/app/main.py`);
// Richieste senza alcun path: devono ereditare il progetto della loro finestra.
await ask('window-1', 'genera un titolo per questa conversazione');
await ask('window-2', 'e adesso?');

await delay(500);
// `close` fa l'ultimo flush: qui si chiude il cerchio fra proxy e collector.
await app.close();
upstream.close();
collector.close();
rmSync(root, { recursive: true, force: true });

const counts = new Map();
for (const event of received) {
  const key = [
    event.projectId,
    event.projectSource,
    // `repo_owner` e' il gruppo piu' esterno, come lo memorizza il server.
    event.repository?.groups[0] ?? '',
    event.repository?.name ?? '',
  ].join('|');
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const rows = [...counts.entries()]
  .map(([key, requests]) => {
    const [project_id, project_source, repo_owner, repo_name] = key.split('|');
    return { project_id, project_source, repo_owner, repo_name, requests };
  })
  .sort((a, b) => a.project_id.localeCompare(b.project_id) || a.project_source.localeCompare(b.project_source));
console.table(rows);

const expected = [
  {
    project_id: 'acme/legacy-crm',
    project_source: 'session',
    repo_owner: 'acme',
    repo_name: 'legacy-crm',
    requests: 1,
  },
  {
    project_id: 'acme/legacy-crm',
    project_source: 'workspace',
    repo_owner: 'acme',
    repo_name: 'legacy-crm',
    requests: 1,
  },
  {
    project_id: 'acme/web/portal',
    project_source: 'session',
    repo_owner: 'acme',
    repo_name: 'portal',
    requests: 1,
  },
  {
    project_id: 'acme/web/portal',
    project_source: 'workspace',
    repo_owner: 'acme',
    repo_name: 'portal',
    requests: 1,
  },
];
const ok = JSON.stringify(rows) === JSON.stringify(expected);
console.log(
  ok
    ? 'OK   progetti identificati dal remote Git, senza configurazione per repository'
    : 'FALLITO',
);

process.exit(ok ? 0 : 1);
