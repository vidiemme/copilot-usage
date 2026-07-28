export interface ServerConfig {
  port: number;
  host: string;
  logLevel: string;
  databaseUrl: string;
  dbSsl: boolean;
  /** Token accettati sull'endpoint di ingest, uno per postazione o per team. */
  ingestTokens: string[];
  tlsKeyPath: string | undefined;
  tlsCertPath: string | undefined;
  flushIntervalMs: number;
  flushMaxBatch: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Variabile d'ambiente mancante: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

function intOption(name: string, fallback: number): number {
  const parsed = Number.parseInt(optional(name, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Lunghezza minima perche' un token non sia indovinabile a forza bruta. */
const MIN_TOKEN_LENGTH = 32;

export function loadConfig(): ServerConfig {
  const ingestTokens = required('INGEST_TOKENS')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  // Si fallisce alla partenza invece di accettare traffico non autenticato:
  // l'endpoint di ingest e' esposto su Internet.
  if (ingestTokens.length === 0) {
    throw new Error('INGEST_TOKENS deve contenere almeno un token');
  }
  const weak = ingestTokens.filter((token) => token.length < MIN_TOKEN_LENGTH);
  if (weak.length > 0) {
    throw new Error(
      `INGEST_TOKENS contiene ${weak.length} token piu' corti di ${MIN_TOKEN_LENGTH} caratteri: generali con "openssl rand -hex 32"`,
    );
  }

  return {
    port: intOption('PORT', 8080),
    host: optional('HOST', '0.0.0.0'),
    logLevel: optional('LOG_LEVEL', 'info'),
    databaseUrl: required('DATABASE_URL'),
    dbSsl: optional('DB_SSL', 'false') === 'true',
    ingestTokens,
    tlsKeyPath: process.env.TLS_KEY_PATH?.trim() || undefined,
    tlsCertPath: process.env.TLS_CERT_PATH?.trim() || undefined,
    flushIntervalMs: intOption('FLUSH_INTERVAL_MS', 2000),
    flushMaxBatch: intOption('FLUSH_MAX_BATCH', 100),
  };
}
