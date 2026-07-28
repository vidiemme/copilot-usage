/**
 * Contratto fra il client locale e il servizio di raccolta.
 *
 * Il client misura e attribuisce; il server prezza e conserva. Il confine e'
 * volutamente povero: passano solo contatori e identificatori, mai prompt,
 * completion o credenziali. Il costo non e' nel payload perche' il listino sta
 * sul server: un client vecchio non deve poter scrivere prezzi sbagliati, ne'
 * un client manomesso poter dichiarare quanto ha speso.
 */

export interface RepositoryIdentity {
  /** Identificatore canonico: `gruppo/sottogruppo/repo`, come sul server Git. */
  projectId: string;
  host: string | null;
  /** Gruppi parent in ordine, dal piu' esterno: base per le aggregazioni. */
  groups: string[];
  name: string;
  /** `null` quando l'identita' e' stata dedotta dal nome della cartella. */
  remoteUrl: string | null;
}

/**
 * Contatori di token normalizzati, indipendenti dal protocollo upstream.
 *
 * Le famiglie non sono sovrapposte: `inputTokens` esclude i token serviti
 * dalla cache, cosi' ogni contatore ha la sua tariffa senza doppi conteggi.
 */
export interface TokenCounters {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** Totale dei token in ingresso, cache inclusa. */
export function totalInputTokens(usage: TokenCounters): number {
  return usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
}

export interface UsageEventPayload {
  /** Chiave di deduplica: rende i rinvii sicuri. */
  requestId: string;
  occurredAt: string;
  developerId: string;
  developerSource: string;
  projectId: string;
  projectSource: string;
  repository: RepositoryIdentity | null;
  clientName: string | null;
  sessionId: string | null;
  endpoint: string;
  model: string | null;
  usage: TokenCounters;
  streamed: boolean;
  durationMs: number | null;
}

export interface IngestBody {
  events: UsageEventPayload[];
}

/** Limite di eventi per richiesta: vale sia da guida al client sia da tetto lato server. */
export const MAX_EVENTS_PER_BATCH = 500;

const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 500;
const MAX_GROUPS = 20;
/** Un contatore oltre questa soglia e' certamente un errore, non un consumo reale. */
const MAX_TOKENS = 1_000_000_000;

export class InvalidEventError extends Error {}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidEventError('oggetto atteso');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, max = MAX_ID_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidEventError(`${field} mancante`);
  }
  return value.slice(0, max);
}

function optionalString(value: unknown, max = MAX_TEXT_LENGTH): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function counter(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidEventError(`${field} non numerico`);
  }
  const rounded = Math.floor(value);
  if (rounded < 0 || rounded > MAX_TOKENS) {
    throw new InvalidEventError(`${field} fuori intervallo`);
  }
  return rounded;
}

function timestamp(value: unknown): string {
  const parsed = new Date(requiredString(value, 'occurredAt', 40));
  if (Number.isNaN(parsed.getTime())) throw new InvalidEventError('occurredAt non valido');
  return parsed.toISOString();
}

function repository(value: unknown): RepositoryIdentity | null {
  if (value === null || value === undefined) return null;
  const raw = asObject(value);
  const groups = Array.isArray(raw.groups) ? raw.groups : [];

  return {
    projectId: requiredString(raw.projectId, 'repository.projectId'),
    host: optionalString(raw.host, MAX_ID_LENGTH),
    groups: groups
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .slice(0, MAX_GROUPS)
      .map((item) => item.slice(0, MAX_ID_LENGTH)),
    name: requiredString(raw.name, 'repository.name'),
    remoteUrl: optionalString(raw.remoteUrl, MAX_TEXT_LENGTH),
  };
}

/**
 * Normalizza un evento proveniente dalla rete.
 *
 * Tronca invece di rifiutare sui campi descrittivi, cosi' un client con un
 * user-agent anomalo non perde la misura; rifiuta solo cio' che renderebbe il
 * dato insensato o inutilizzabile come chiave.
 */
export function parseUsageEvent(input: unknown): UsageEventPayload {
  const raw = asObject(input);
  const usage = asObject(raw.usage);

  return {
    requestId: requiredString(raw.requestId, 'requestId'),
    occurredAt: timestamp(raw.occurredAt),
    developerId: requiredString(raw.developerId, 'developerId'),
    developerSource: requiredString(raw.developerSource, 'developerSource', 40),
    projectId: requiredString(raw.projectId, 'projectId'),
    projectSource: requiredString(raw.projectSource, 'projectSource', 40),
    repository: repository(raw.repository),
    clientName: optionalString(raw.clientName, 200),
    sessionId: optionalString(raw.sessionId, MAX_ID_LENGTH),
    endpoint: requiredString(raw.endpoint, 'endpoint', MAX_TEXT_LENGTH),
    model: optionalString(raw.model, MAX_ID_LENGTH),
    usage: {
      inputTokens: counter(usage.inputTokens, 'usage.inputTokens'),
      cachedInputTokens: counter(usage.cachedInputTokens, 'usage.cachedInputTokens'),
      cacheWriteTokens: counter(usage.cacheWriteTokens, 'usage.cacheWriteTokens'),
      outputTokens: counter(usage.outputTokens, 'usage.outputTokens'),
    },
    streamed: raw.streamed === true,
    durationMs:
      typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)
        ? Math.max(0, Math.floor(raw.durationMs))
        : null,
  };
}

export function parseIngestBody(input: unknown): IngestBody {
  const raw = asObject(input);
  if (!Array.isArray(raw.events)) throw new InvalidEventError('events deve essere un array');
  if (raw.events.length === 0) throw new InvalidEventError('events vuoto');
  if (raw.events.length > MAX_EVENTS_PER_BATCH) {
    throw new InvalidEventError(`troppi eventi: massimo ${MAX_EVENTS_PER_BATCH}`);
  }

  return { events: raw.events.map(parseUsageEvent) };
}
