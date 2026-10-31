import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TokenCounters } from '@vidiemme/copilot-usage-contract';

/** Una chiamata al modello registrata da Copilot CLI o da una sessione agentica in VS Code. */
export interface CliCall {
  /** `serviceRequestId` di GitHub quando c'e': lo stesso che il proxy usa come chiave. */
  requestId: string;
  occurredAt: Date;
  cwd: string;
  sessionId: string;
  model: string | null;
  endpoint: string | null;
  usage: TokenCounters;
  durationMs: number | null;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function defaultSessionStateDir(): string {
  return join(process.env.COPILOT_HOME?.trim() || join(homedir(), '.copilot'), 'session-state');
}

function sessionCwd(sessionDir: string): string | undefined {
  try {
    const yaml = readFileSync(join(sessionDir, 'workspace.yaml'), 'utf-8');
    return /^cwd:\s*(.+?)\s*$/m.exec(yaml)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Normalizza un `session.usage_record`.
 *
 * Qui `inputTokens` e' il totale e comprende la cache; nel contratto invece le
 * famiglie non si sovrappongono, quindi la parte servita dalla cache va tolta.
 */
export function parseUsageRecord(line: string, cwd: string, sessionId: string): CliCall | undefined {
  let record: Json | undefined;
  try {
    record = asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
  if (record?.type !== 'session.usage_record') return undefined;
  const usage = asObject(asObject(record.data)?.usage);
  if (!usage) return undefined;

  const id = text(usage.serviceRequestId) ?? text(usage.apiCallId) ?? text(record.id);
  const at = new Date(typeof record.timestamp === 'string' ? record.timestamp : NaN);
  if (!id || Number.isNaN(at.getTime())) return undefined;

  const cached = count(usage.cacheReadTokens);
  const written = count(usage.cacheWriteTokens);
  return {
    requestId: text(usage.serviceRequestId) ? id : `copilot-cli:${id}`,
    occurredAt: at,
    cwd,
    sessionId,
    model: text(usage.model),
    endpoint: text(usage.apiEndpoint),
    usage: {
      inputTokens: Math.max(0, count(usage.inputTokens) - cached - written),
      cachedInputTokens: cached,
      cacheWriteTokens: written,
      outputTokens: count(usage.outputTokens),
    },
    durationMs: typeof usage.duration === 'number' ? count(usage.duration) : null,
  };
}

/** Legge le chiamate registrate nelle sessioni di Copilot CLI. */
export function readCliCalls(stateDir = defaultSessionStateDir(), modifiedSince?: Date): CliCall[] {
  let sessions: string[];
  try {
    sessions = readdirSync(stateDir);
  } catch {
    return [];
  }

  const byId = new Map<string, CliCall>();
  for (const sessionId of sessions) {
    const sessionDir = join(stateDir, sessionId);
    const eventsFile = join(sessionDir, 'events.jsonl');
    let content: string;
    try {
      if (modifiedSince && statSync(eventsFile).mtime < modifiedSince) continue;
      content = readFileSync(eventsFile, 'utf-8');
    } catch {
      continue;
    }
    const cwd = sessionCwd(sessionDir);
    if (!cwd) continue;

    for (const line of content.split('\n')) {
      // Filtro economico prima del parse: la gran parte delle righe sono messaggi.
      if (!line.includes('"session.usage_record"')) continue;
      const call = parseUsageRecord(line, cwd, sessionId);
      // Le sessioni biforcate ricopiano gli eventi della sessione d'origine.
      if (call && !byId.has(call.requestId)) byId.set(call.requestId, call);
    }
  }
  return [...byId.values()];
}
