// Verifica del reporting: inietta eventi finti su piu' giorni, progetti e
// developer attraverso l'API di ingest, poi interroga gli endpoint di analisi.
// Uso: node scripts/verify-reporting.mjs   (dal pacchetto server)
import '../dist/env.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const PORT = 9922;
const CLIENT = 'verify-reporting';

process.env.LOG_LEVEL ??= 'silent';

const { loadConfig } = await import('../dist/config.js');
const { buildApp } = await import('../dist/server.js');

const config = loadConfig();
const app = await buildApp(config);
await app.server.listen({ port: PORT, host: '127.0.0.1' });

const base = `http://127.0.0.1:${PORT}`;
const token = config.ingestTokens[0];

function event(developerId, projectId) {
  return {
    requestId: randomUUID(),
    occurredAt: new Date().toISOString(),
    developerId,
    developerSource: 'path',
    projectId,
    projectSource: 'path',
    repository: null,
    clientName: CLIENT,
    sessionId: null,
    endpoint: '/chat/completions',
    model: 'claude-opus-4.5',
    usage: {
      inputTokens: 2000,
      cachedInputTokens: 10000,
      cacheWriteTokens: 0,
      outputTokens: 800,
    },
    streamed: true,
    durationMs: 120,
  };
}

const events = [
  ...Array.from({ length: 3 }, () => event('g.carassale', 'acme-portal')),
  ...Array.from({ length: 1 }, () => event('g.carassale', 'legacy-crm')),
  ...Array.from({ length: 2 }, () => event('m.rossi', 'acme-portal')),
];

const ingest = await fetch(`${base}/v1/usage`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ events }),
});
console.log(`ingest -> HTTP ${ingest.status} ${JSON.stringify(await ingest.json())}`);

const noAuth = await fetch(`${base}/v1/usage`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ events }),
});
console.log(`ingest senza token -> HTTP ${noAuth.status} (atteso 401)`);

// Attende il flush del writer batch.
await new Promise((r) => setTimeout(r, 2500));

const db = new pg.Client(config.databaseUrl);
await db.connect();

// Retrodata una parte degli eventi per verificare i raggruppamenti temporali.
await db.query(
  "UPDATE usage_events SET occurred_at = occurred_at - INTERVAL '2 days' WHERE project_id = 'legacy-crm'",
);
await db.query(
  `INSERT INTO developers (developer_id, display_name, team)
   VALUES ('g.carassale', 'Gabriele Carassale', 'red_tech')
   ON CONFLICT (developer_id) DO UPDATE
     SET display_name = EXCLUDED.display_name, team = EXCLUDED.team`,
);

const show = async (label, url) => {
  const res = await fetch(`${base}${url}`);
  const json = await res.json();
  console.log(`\n### ${label}  [HTTP ${res.status}]`);
  console.table(json.rows);
};

await show('per progetto', '/_usage/summary?groupBy=project');
await show('per developer e progetto', '/_usage/summary?groupBy=developer,project');
await show('per giorno e progetto', '/_usage/summary?groupBy=project&interval=day');
await show('per team', '/_usage/summary?groupBy=team');
await show('filtrato su acme-portal', '/_usage/summary?groupBy=developer&project=acme-portal');
await show('anagrafica developer', '/_usage/developers');

const bad = await fetch(`${base}/_usage/summary?groupBy=project;DROP TABLE usage_events`);
console.log(`\ngroupBy non valido -> HTTP ${bad.status} (atteso 400)`);

await db.query('DELETE FROM usage_events WHERE client_name = $1', [CLIENT]);
await db.query("DELETE FROM developers WHERE developer_id = 'g.carassale'");
await db.end();
await app.close().catch(() => {});
process.exit(0);
