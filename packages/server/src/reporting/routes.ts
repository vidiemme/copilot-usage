import type { FastifyInstance } from 'fastify';
import { expiredRates, rateCard } from '../pricing/rateCard.js';
import type { Db } from '../storage/db.js';

interface SummaryQuery {
  from?: string;
  to?: string;
  groupBy?: string;
  interval?: string;
  project?: string;
  developer?: string;
}

/**
 * Dimensioni raggruppabili. I valori finiscono testualmente nella query, quindi
 * possono provenire solo da questa whitelist, mai dall'input utente.
 */
const DIMENSIONS: Record<string, string> = {
  project: 'project_id',
  owner: 'repo_owner',
  repo: 'repo_name',
  host: 'repo_host',
  developer: 'developer_name',
  team: 'developer_team',
  model: 'canonical_model',
  vendor: 'vendor',
  client: 'client_name',
  source: 'project_source',
};

const INTERVALS: Record<string, string | null> = {
  none: null,
  day: 'day',
  week: 'week',
  month: 'month',
};

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export function registerReportingRoutes(app: FastifyInstance, db: Db): void {
  app.get('/_health', async () => {
    const expired = expiredRates();
    return {
      ok: true,
      rateCardVersion: rateCard.version,
      // Se popolato, il listino contiene tariffe scadute: il costo calcolato
      // per quei modelli non e' piu' attendibile.
      expiredRates: expired.map((entry) => ({ model: entry.model, validUntil: entry.validUntil })),
    };
  });

  app.get<{ Querystring: SummaryQuery }>('/_usage/summary', async (request, reply) => {
    const { from, to, groupBy = 'project', interval = 'none', project, developer } = request.query;

    const dimensions = groupBy
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    // Whitelist: i nomi colonna finiscono testualmente nella query, non devono
    // mai provenire direttamente dall'input utente.
    const columns = dimensions.map((name) => DIMENSIONS[name]);
    if (columns.some((column) => column === undefined)) {
      await reply.code(400).send({ error: 'groupBy_non_valido', allowed: Object.keys(DIMENSIONS) });
      return;
    }

    if (!(interval in INTERVALS)) {
      await reply.code(400).send({ error: 'interval_non_valido', allowed: Object.keys(INTERVALS) });
      return;
    }
    const bucket = INTERVALS[interval];

    if (columns.length === 0 && !bucket) {
      await reply.code(400).send({ error: 'serve almeno una dimensione o un interval' });
      return;
    }

    const now = new Date();
    const params: unknown[] = [
      parseDate(from, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)),
      parseDate(to, now),
    ];
    const filters = ['occurred_at >= $1', 'occurred_at < $2'];

    if (project) {
      params.push(project);
      filters.push(`project_id = $${params.length}`);
    }
    if (developer) {
      params.push(developer);
      filters.push(`developer_name = $${params.length}`);
    }

    const selected = [...(bucket ? [`${bucket} AS bucket`] : []), ...(columns as string[])];
    const groupIndexes = selected.map((_, index) => index + 1).join(', ');

    const result = await db.query(
      `SELECT ${selected.join(', ')},
              COUNT(*)::BIGINT                  AS requests,
              SUM(input_tokens)::BIGINT         AS input_tokens,
              SUM(cached_input_tokens)::BIGINT  AS cached_input_tokens,
              SUM(cache_write_tokens)::BIGINT   AS cache_write_tokens,
              SUM(output_tokens)::BIGINT        AS output_tokens,
              ROUND(SUM(cost_usd), 4)::FLOAT8   AS cost_usd,
              ROUND(SUM(ai_credits), 2)::FLOAT8 AS ai_credits
       FROM usage_enriched
       WHERE ${filters.join(' AND ')}
       GROUP BY ${groupIndexes}
       ORDER BY ${bucket ? '1 DESC, ' : ''}cost_usd DESC`,
      params,
    );

    return { groupBy: dimensions, interval, rows: result.rows };
  });

  /** Pseudonimi visti sul traffico, con l'eventuale nome associato. */
  app.get('/_usage/developers', async () => {
    const result = await db.query(
      `SELECT e.developer_id,
              MAX(d.display_name)               AS display_name,
              MIN(e.occurred_at)                AS first_seen,
              MAX(e.occurred_at)                AS last_seen,
              ARRAY_AGG(DISTINCT e.client_name)
                FILTER (WHERE e.client_name IS NOT NULL) AS clients,
              ROUND(SUM(e.cost_usd), 4)::FLOAT8 AS cost_usd
       FROM usage_events e
       LEFT JOIN developers d ON d.developer_id = e.developer_id
       GROUP BY e.developer_id
       ORDER BY cost_usd DESC`,
    );
    return { rows: result.rows };
  });

  /** Repository riconosciuti, con la gerarchia dei gruppi di appartenenza. */
  app.get('/_usage/projects', async () => {
    const result = await db.query(
      `SELECT e.project_id,
              MAX(p.repo_owner)                 AS repo_owner,
              MAX(p.repo_name)                  AS repo_name,
              MAX(p.repo_host)                  AS repo_host,
              MAX(p.remote_url)                 AS remote_url,
              MIN(e.occurred_at)                AS first_seen,
              MAX(e.occurred_at)                AS last_seen,
              COUNT(DISTINCT e.developer_id)::INT AS developers,
              ROUND(SUM(e.cost_usd), 4)::FLOAT8 AS cost_usd
       FROM usage_events e
       LEFT JOIN projects p ON p.project_id = e.project_id
       GROUP BY e.project_id
       ORDER BY cost_usd DESC`,
    );
    return { rows: result.rows };
  });

  app.get('/_usage/unknown-models', async () => {
    const result = await db.query(
      'SELECT raw_model, occurrences, first_seen, last_seen FROM unknown_models ORDER BY occurrences DESC LIMIT 100',
    );
    return { rows: result.rows };
  });
}
