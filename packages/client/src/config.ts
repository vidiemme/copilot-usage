import { createHash } from 'node:crypto';
import { defaultSpoolPath } from './paths.js';

/** Sorgente dei valori di configurazione: `process.env` o una mappa equivalente. */
export type ConfigSource = Record<string, string | undefined>;

export interface AttributionMapping {
  projectId?: string;
  developerId?: string;
}

export interface ClientConfig {
  port: number;
  host: string;
  logLevel: string;
  upstreamBaseUrl: string;
  upstreamAuthToken: string | undefined;
  tlsKeyPath: string | undefined;
  tlsCertPath: string | undefined;
  /** Endpoint di raccolta, es. `https://copilot-usage.interno/v1/usage`. */
  collectorUrl: string;
  collectorToken: string;
  collectorTimeoutMs: number;
  /** File su cui parcheggiare gli eventi quando il servizio non risponde. */
  spoolPath: string;
  projectHeader: string;
  unassignedProject: string;
  workspaceRoots: string[];
  projectMarkers: string[];
  projectStickyTtlMs: number;
  attributionTokens: Record<string, AttributionMapping>;
  developerIdSalt: string;
  flushIntervalMs: number;
  flushMaxBatch: number;
}

function parseAttributionTokens(raw: string): Record<string, AttributionMapping> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Record<string, AttributionMapping>;
  } catch {
    throw new Error("ATTRIBUTION_TOKENS non e' un JSON valido");
  }
}

/**
 * Costruisce la configurazione da una sorgente di chiavi.
 *
 * La sorgente e' iniettabile perche' il comando `start` sovrappone piu' livelli
 * — file di configurazione utente, ambiente, opzioni della riga di comando —
 * prima di arrivare qui.
 */
export function loadConfig(source: ConfigSource = process.env): ClientConfig {
  const read = (name: string): string | undefined => source[name]?.trim() || undefined;

  const required = (name: string): string => {
    const value = read(name);
    if (!value) throw new Error(`Configurazione mancante: ${name}`);
    return value;
  };
  const optional = (name: string, fallback: string): string => read(name) ?? fallback;
  const intOption = (name: string, fallback: number): number => {
    const parsed = Number.parseInt(optional(name, String(fallback)), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const listOption = (name: string, fallback: string): string[] =>
    optional(name, fallback)
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

  const developerIdSalt = optional('DEVELOPER_ID_SALT', '');
  if (developerIdSalt.length === 0 || developerIdSalt === 'change-me') {
    throw new Error(
      'DEVELOPER_ID_SALT deve essere impostato con un valore casuale: protegge lo pseudonimo del developer dal reverse lookup. Deve essere lo stesso su tutte le postazioni, altrimenti la stessa persona risulta come piu\' developer diversi',
    );
  }

  const collectorUrl = required('COLLECTOR_URL');
  if (
    collectorUrl.startsWith('http://') &&
    !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(collectorUrl)
  ) {
    throw new Error(
      'COLLECTOR_URL deve usare https: in chiaro il token di ingest sarebbe leggibile sulla rete',
    );
  }

  return {
    port: intOption('PORT', 8787),
    host: optional('HOST', '127.0.0.1'),
    logLevel: optional('LOG_LEVEL', 'info'),
    upstreamBaseUrl: optional('UPSTREAM_BASE_URL', 'https://api.githubcopilot.com').replace(
      /\/+$/,
      '',
    ),
    upstreamAuthToken: read('UPSTREAM_AUTH_TOKEN'),
    tlsKeyPath: read('TLS_KEY_PATH'),
    tlsCertPath: read('TLS_CERT_PATH'),
    collectorUrl,
    collectorToken: required('COLLECTOR_TOKEN'),
    collectorTimeoutMs: intOption('COLLECTOR_TIMEOUT_MS', 10_000),
    spoolPath: optional('SPOOL_PATH', defaultSpoolPath()),
    projectHeader: optional('PROJECT_HEADER', 'x-project-id').toLowerCase(),
    unassignedProject: optional('UNASSIGNED_PROJECT', 'unassigned'),
    workspaceRoots: listOption('WORKSPACE_ROOTS', ''),
    projectMarkers: listOption('PROJECT_MARKERS', '.git,.hg,.svn'),
    projectStickyTtlMs: intOption('PROJECT_STICKY_TTL_MS', 30 * 60_000),
    attributionTokens: parseAttributionTokens(optional('ATTRIBUTION_TOKENS', '{}')),
    developerIdSalt,
    flushIntervalMs: intOption('FLUSH_INTERVAL_MS', 5000),
    flushMaxBatch: intOption('FLUSH_MAX_BATCH', 100),
  };
}

/**
 * Pseudonimo stabile e non invertibile derivato da un segreto del client.
 * Serve a distinguere i developer senza conservare credenziali.
 */
export function pseudonymize(secret: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${secret}`).digest('hex').slice(0, 16);
}

/**
 * Estrae dalla credenziale la porzione che identifica la persona.
 *
 * Il token Copilot e' una lista di coppie `chiave=valore` separate da `;` e
 * viene rinnovato di continuo: campi come `exp` cambiano a ogni rotazione. Fare
 * l'hash del token intero produrrebbe un developer diverso ogni mezz'ora,
 * frammentando qualsiasi analisi nel tempo. Si isolano quindi i soli campi
 * stabili, con fallback al token completo per credenziali di altro formato.
 */
const STABLE_TOKEN_FIELDS = ['u', 'tid', 'oid', 'sid'];

export function stableIdentity(token: string): string {
  if (!token.includes('=') || !token.includes(';')) return token;

  const fields = new Map<string, string>();
  for (const pair of token.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    fields.set(pair.slice(0, separator).trim().toLowerCase(), pair.slice(separator + 1).trim());
  }

  for (const key of STABLE_TOKEN_FIELDS) {
    const value = fields.get(key);
    if (value) return `${key}:${value}`;
  }

  return token;
}
