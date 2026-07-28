// Verifica end-to-end del taglio client/server: il proxy locale misura, il
// collector remoto prezza e persiste.
// Presuppone il servizio di raccolta gia' avviato e le migrazioni applicate.
// Uso: node scripts/verify-e2e.mjs   (dal pacchetto client)
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const UPSTREAM_PORT = 9941;
const PROXY_PORT = 9942;
const CLIENT = 'verify-e2e';

const root = mkdtempSync(join(tmpdir(), 'verify-e2e-'));
const gitDir = join(root, 'progetto', '.git');
mkdirSync(gitDir, { recursive: true });
writeFileSync(join(gitDir, 'config'), '[remote "origin"]\n\turl = git@github.com:acme/e2e-demo.git\n');

const upstream = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': `${CLIENT}-1` });
    res.write(
      'data: {"model":"gpt-5.4","choices":[],"usage":{"prompt_tokens":1000000,"completion_tokens":100000}}\n\n',
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, resolve));

process.env.UPSTREAM_BASE_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
process.env.SPOOL_PATH = join(root, 'spool.jsonl');
process.env.WORKSPACE_ROOTS = root;
process.env.PORT = String(PROXY_PORT);
process.env.LOG_LEVEL ??= 'silent';

const { loadConfig } = await import('../dist/config.js');
const { buildApp } = await import('../dist/server.js');

const app = await buildApp(loadConfig());
await app.server.listen({ port: PROXY_PORT, host: '127.0.0.1' });

const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer tid=abc123;u=99887;exp=1784990000',
    'vscode-sessionid': 'e2e-window',
    'user-agent': CLIENT,
  },
  body: JSON.stringify({
    model: 'gpt-5.4',
    stream: true,
    messages: [{ role: 'user', content: `spiega ${root}/progetto/src/index.ts` }],
  }),
});
for await (const chunk of response.body) void chunk;

await app.close();
upstream.close();
rmSync(root, { recursive: true, force: true });

// Il writer del collector accumula in batch: si concede il tempo di un flush.
await delay(3000);

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: process.env.VERIFY_DATABASE_URL });
const { rows } = await pool.query(
  `SELECT e.project_id, e.canonical_model, e.input_tokens, e.output_tokens,
          e.cost_usd::float8, e.priced, p.repo_owner, p.repo_name
     FROM usage_events e
     LEFT JOIN projects p ON p.project_id = e.project_id
    WHERE e.client_name = $1`,
  [CLIENT],
);
console.table(rows);

const row = rows[0];
const checks = {
  'evento persistito una sola volta': rows.length === 1,
  'progetto dal remote Git': row?.project_id === 'acme/e2e-demo',
  'anagrafica repository popolata': row?.repo_owner === 'acme' && row?.repo_name === 'e2e-demo',
  'modello riconosciuto dal listino': row?.priced === true,
  'contatori trasportati intatti': row?.input_tokens === 1000000 && row?.output_tokens === 100000,
  'costo calcolato dal server': typeof row?.cost_usd === 'number' && row.cost_usd > 0,
};
for (const [label, ok] of Object.entries(checks)) console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);

await pool.query('DELETE FROM usage_events WHERE client_name = $1', [CLIENT]);
await pool.query("DELETE FROM projects WHERE project_id = 'acme/e2e-demo'");
await pool.end();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
