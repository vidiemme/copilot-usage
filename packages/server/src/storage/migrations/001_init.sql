-- Eventi di consumo token del proxy Copilot.
-- Ogni riga = una risposta completata da un modello.

CREATE TABLE IF NOT EXISTS usage_events (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at         TIMESTAMPTZ    NOT NULL,
    request_id          TEXT           NOT NULL,
    developer_id        TEXT           NOT NULL,
    project_id          TEXT           NOT NULL,
    project_source      TEXT           NOT NULL,
    client_name         TEXT,
    session_id          TEXT,
    endpoint            TEXT           NOT NULL,

    raw_model           TEXT,
    canonical_model     TEXT,
    vendor              TEXT,
    tier                TEXT,

    input_tokens        INTEGER        NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER        NOT NULL DEFAULT 0,
    cache_write_tokens  INTEGER        NOT NULL DEFAULT 0,
    output_tokens       INTEGER        NOT NULL DEFAULT 0,

    -- Il costo viene congelato alla scrittura insieme alla versione del
    -- listino usata: un aggiornamento dei prezzi non deve riscrivere lo storico.
    rate_card_version   TEXT           NOT NULL,
    cost_usd            NUMERIC(18, 10) NOT NULL DEFAULT 0,
    ai_credits          NUMERIC(18, 8)  NOT NULL DEFAULT 0,
    priced              BOOLEAN        NOT NULL DEFAULT FALSE,

    streamed            BOOLEAN        NOT NULL DEFAULT FALSE,
    duration_ms         INTEGER,

    CONSTRAINT usage_events_request_id_key UNIQUE (request_id)
);

CREATE INDEX IF NOT EXISTS usage_events_project_time_idx
    ON usage_events (project_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS usage_events_developer_time_idx
    ON usage_events (developer_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS usage_events_model_time_idx
    ON usage_events (canonical_model, occurred_at DESC);

-- Modelli visti sul traffico ma assenti dal listino: segnale di listino
-- da aggiornare, altrimenti quel consumo resta a costo zero.
CREATE TABLE IF NOT EXISTS unknown_models (
    raw_model   TEXT PRIMARY KEY,
    first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    occurrences BIGINT      NOT NULL DEFAULT 0
);

-- Le viste di analisi sono definite tutte insieme nella migrazione piu'
-- recente: le migrazioni vengono rigiocate per intero a ogni avvio, e una
-- vista ridefinita in due file darebbe errore al secondo passaggio.
