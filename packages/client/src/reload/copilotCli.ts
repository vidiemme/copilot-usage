import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mergeHydraFusion, type TokenCounters } from '@vidiemme/copilot-usage-contract';
import { fusionFromCliUsage } from '../usage/fusion.js';

/** Una chiamata al modello registrata da Copilot CLI o da una sessione agentica in VS Code. */
export interface CliCall {
  /** `serviceRequestId` di GitHub quando c'e': corrisponde all'header Copilot del proxy. */
  requestId: string;
  occurredAt: Date;
  cwd: string;
  sessionId: string;
  model: string | null;
  hydraFusion?: boolean | null;
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

export function defaultSessionStateDir(copilotHome = process.env.COPILOT_HOME): string {
  return join(copilotHome?.trim() || join(homedir(), '.copilot'), 'session-state');
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
export function parseUsageRecord(
  line: string,
  cwd: string,
  sessionId: string,
  selectedModel?: string,
  onInvalid?: () => void,
): CliCall | undefined {
  let record: Json | undefined;
  try {
    record = asObject(JSON.parse(line));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    onInvalid?.();
    return undefined;
  }
  if (record?.type !== 'session.usage_record') return undefined;
  const usage = asObject(asObject(record.data)?.usage);
  if (!usage) {
    onInvalid?.();
    return undefined;
  }

  const id = text(usage.serviceRequestId) ?? text(usage.apiCallId) ?? text(record.id);
  const at = new Date(typeof record.timestamp === 'string' ? record.timestamp : NaN);
  if (!id || Number.isNaN(at.getTime())) {
    onInvalid?.();
    return undefined;
  }

  const cached = count(usage.cacheReadTokens);
  const written = count(usage.cacheWriteTokens);
  return {
    requestId: text(usage.serviceRequestId) ? id : `copilot-cli:${id}`,
    occurredAt: at,
    cwd,
    sessionId,
    model: text(usage.model),
    hydraFusion: fusionFromCliUsage(usage, selectedModel),
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

/** Modello scelto nella sessione, aggiornato a ogni cambio esplicito. */
function parseSelectedModel(
  line: string,
  onInvalid: () => void,
): { selectedModel: string | undefined } | undefined {
  try {
    const record = asObject(JSON.parse(line));
    const data = asObject(record?.data);
    if (record?.type === 'session.start') return { selectedModel: text(data?.selectedModel) ?? undefined };
    if (record?.type === 'session.model_change') return { selectedModel: text(data?.newModel) ?? undefined };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    onInvalid();
    return { selectedModel: undefined };
  }
  return undefined;
}

/** Stato di lettura di una sessione, conservato fra letture successive dello stesso file. */
export interface SessionCursor {
  selectedModel?: string | undefined;
}

/** Chiamate di una sessione, ciascuna con il modello selezionato in quel momento. */
export function* sessionCalls(
  lines: Iterable<string>,
  cwd: string,
  sessionId: string,
  onInvalid: () => void,
  cursor: SessionCursor = {},
): Generator<CliCall> {
  for (const line of lines) {
    // Filtro economico prima del parse: la gran parte delle righe sono messaggi.
    if (line.includes('"session.start"') || line.includes('"session.model_change"')) {
      const selection = parseSelectedModel(line, onInvalid);
      if (selection) cursor.selectedModel = selection.selectedModel;
      continue;
    }
    if (!line.includes('"session.usage_record"')) continue;
    const call = parseUsageRecord(line, cwd, sessionId, cursor.selectedModel, onInvalid);
    if (call) yield call;
  }
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

    let warned = false;
    const warnInvalid = (): void => {
      if (warned) return;
      warned = true;
      console.warn(`Record Copilot non valido nella sessione ${sessionId}: routing non determinabile`);
    };
    for (const call of sessionCalls(content.split('\n'), cwd, sessionId, warnInvalid)) {
      // Le sessioni biforcate ricopiano gli eventi della sessione d'origine.
      const previous = byId.get(call.requestId);
      byId.set(
        call.requestId,
        previous ? { ...previous, hydraFusion: mergeHydraFusion(previous.hydraFusion, call.hydraFusion) } : call,
      );
    }
  }
  return [...byId.values()];
}
