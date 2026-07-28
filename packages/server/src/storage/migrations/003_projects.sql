-- Anagrafica dei repository, per aggregare oltre il singolo progetto.

-- Il nome della cartella locale lo sceglie chi clona: come chiave sarebbe
-- instabile fra macchine diverse. L'identita' viene quindi dal remote Git, e i
-- gruppi parent restano disponibili per le aggregazioni per cliente o unita'.
CREATE TABLE IF NOT EXISTS projects (
    project_id   TEXT PRIMARY KEY,
    repo_host    TEXT,
    repo_owner   TEXT,
    repo_groups  TEXT[] NOT NULL DEFAULT '{}',
    repo_name    TEXT,
    remote_url   TEXT,
    display_name TEXT,
    first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects (repo_owner);

-- Le viste vanno ricreate in blocco: usage_enriched cambia forma e le altre
-- dipendono da lei.
DROP VIEW IF EXISTS usage_daily_by_project;
DROP VIEW IF EXISTS usage_daily_by_developer;
DROP VIEW IF EXISTS usage_monthly_by_project;
DROP VIEW IF EXISTS usage_monthly_by_owner;
DROP VIEW IF EXISTS usage_enriched CASCADE;

CREATE VIEW usage_enriched AS
SELECT
    e.*,
    COALESCE(d.display_name, e.developer_id)          AS developer_name,
    d.team                                            AS developer_team,
    COALESCE(p.display_name, e.project_id)            AS project_name,
    p.repo_host                                       AS repo_host,
    p.repo_owner                                      AS repo_owner,
    p.repo_groups                                     AS repo_groups,
    COALESCE(p.repo_name, e.project_id)               AS repo_name,
    DATE_TRUNC('day', e.occurred_at)                  AS day,
    DATE_TRUNC('week', e.occurred_at)                 AS week,
    DATE_TRUNC('month', e.occurred_at)                AS month,
    e.input_tokens + e.cached_input_tokens
        + e.cache_write_tokens + e.output_tokens      AS total_tokens
FROM usage_events e
LEFT JOIN developers d ON d.developer_id = e.developer_id
LEFT JOIN projects   p ON p.project_id   = e.project_id;

CREATE VIEW usage_daily_by_project AS
SELECT
    day,
    project_id,
    repo_owner,
    repo_name,
    developer_name,
    canonical_model,
    COUNT(*)                 AS requests,
    SUM(input_tokens)        AS input_tokens,
    SUM(cached_input_tokens) AS cached_input_tokens,
    SUM(cache_write_tokens)  AS cache_write_tokens,
    SUM(output_tokens)       AS output_tokens,
    SUM(cost_usd)            AS cost_usd,
    SUM(ai_credits)          AS ai_credits
FROM usage_enriched
GROUP BY 1, 2, 3, 4, 5, 6;

CREATE VIEW usage_daily_by_developer AS
SELECT
    day,
    developer_name,
    developer_team,
    COUNT(*)        AS requests,
    SUM(cost_usd)   AS cost_usd,
    SUM(ai_credits) AS ai_credits
FROM usage_enriched
GROUP BY 1, 2, 3;

CREATE VIEW usage_monthly_by_project AS
SELECT
    month,
    project_id,
    repo_owner,
    COUNT(*)                     AS requests,
    COUNT(DISTINCT developer_id) AS developers,
    SUM(total_tokens)            AS total_tokens,
    SUM(cost_usd)                AS cost_usd,
    SUM(ai_credits)              AS ai_credits
FROM usage_enriched
GROUP BY 1, 2, 3;

-- Rollup al livello del gruppo parent: il taglio per cliente o business unit.
CREATE VIEW usage_monthly_by_owner AS
SELECT
    month,
    COALESCE(repo_owner, 'unknown') AS repo_owner,
    COUNT(*)                        AS requests,
    COUNT(DISTINCT project_id)      AS projects,
    COUNT(DISTINCT developer_id)    AS developers,
    SUM(total_tokens)               AS total_tokens,
    SUM(cost_usd)                   AS cost_usd,
    SUM(ai_credits)                 AS ai_credits
FROM usage_enriched
GROUP BY 1, 2;
