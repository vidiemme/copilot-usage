-- Anagrafica developer e viste di analisi.

ALTER TABLE usage_events
    ADD COLUMN IF NOT EXISTS developer_source TEXT NOT NULL DEFAULT 'pseudonym';

-- Consente di dare un nome leggibile agli pseudonimi derivati dal token, e di
-- raggruppare piu' identita' (CLI + estensione) sotto la stessa persona.
CREATE TABLE IF NOT EXISTS developers (
    developer_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    email        TEXT,
    team         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usage_events_time_idx ON usage_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS usage_events_project_developer_time_idx
    ON usage_events (project_id, developer_id, occurred_at DESC);
