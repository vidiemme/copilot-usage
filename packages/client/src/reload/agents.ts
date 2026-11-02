import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TokenCounters } from '@vidiemme/copilot-usage-contract';
import { knownEditors } from '../editors.js';

export type AgentTool = 'claude-code' | 'cline' | 'opencode';

/**
 * Una chiamata al modello registrata da un harness di terze parti. Quale
 * provider ci fosse dietro i log non lo dicono sempre: lo decide chi carica,
 * confrontando il modello con le rotte di LiteLLM.
 */
export interface AgentCall {
  tool: AgentTool;
  requestId: string;
  occurredAt: Date;
  cwd: string | undefined;
  sessionId: string;
  /** Nomi del modello in ordine di affidabilita': quello chiesto, poi quello restituito. */
  models: string[];
  /** Provider dichiarato dal client (`litellm`, `github-copilot`, ...), se lo registra. */
  provider: string | null;
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

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function touchedSince(file: string, since: Date | undefined): boolean {
  if (!since) return true;
  try {
    return statSync(file).mtime >= since;
  } catch {
    return false;
  }
}

function totalTokens(usage: TokenCounters): number {
  return usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.outputTokens;
}

// --- Claude Code -------------------------------------------------------------

export function defaultClaudeProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'), 'projects');
}

/** File di sessione, compresi quelli dei subagent in `<sessione>/subagents/`. */
function jsonlFiles(dir: string, depth = 3): string[] {
  const files: string[] = [];
  for (const name of listDir(dir)) {
    const path = join(dir, name);
    if (name.endsWith('.jsonl')) files.push(path);
    else if (depth > 0 && !name.includes('.')) files.push(...jsonlFiles(path, depth - 1));
  }
  return files;
}

/**
 * Normalizza una riga `assistant` di Claude Code.
 *
 * I contatori sono quelli dell'API Anthropic: `input_tokens` esclude gia' la
 * cache, come nel contratto.
 */
export function parseClaudeLine(line: string): AgentCall | undefined {
  let record: Json | undefined;
  try {
    record = asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
  if (record?.type !== 'assistant' || record.isApiErrorMessage === true) return undefined;
  const message = asObject(record.message);
  const usage = asObject(message?.usage);
  const model = text(message?.model);
  if (!message || !usage || model === '<synthetic>') return undefined;

  const id = text(message.id) ?? text(record.requestId) ?? text(record.uuid);
  const at = new Date(typeof record.timestamp === 'string' ? record.timestamp : NaN);
  if (!id || Number.isNaN(at.getTime())) return undefined;

  return {
    tool: 'claude-code',
    requestId: `claude-code:${id}`,
    occurredAt: at,
    cwd: text(record.cwd) ?? undefined,
    sessionId: text(record.sessionId) ?? 'claude-code',
    models: [text(record.requestedModel), model].filter((name): name is string => !!name),
    provider: null,
    usage: {
      inputTokens: count(usage.input_tokens),
      cachedInputTokens: count(usage.cache_read_input_tokens),
      cacheWriteTokens: count(usage.cache_creation_input_tokens),
      outputTokens: count(usage.output_tokens),
    },
    durationMs: null,
  };
}

/** Legge le chiamate registrate nelle sessioni di Claude Code. */
export function readClaudeCalls(projectsDir = defaultClaudeProjectsDir(), modifiedSince?: Date): AgentCall[] {
  const byId = new Map<string, AgentCall>();
  for (const file of jsonlFiles(projectsDir)) {
    if (!touchedSince(file, modifiedSince)) continue;
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      const call = parseClaudeLine(line);
      if (!call) continue;
      // Ogni blocco della risposta e' una riga con lo stesso id; le sessioni
      // riprese ricopiano le righe. Si tiene la copia piu' completa.
      const known = byId.get(call.requestId);
      if (!known || call.usage.outputTokens > known.usage.outputTokens) byId.set(call.requestId, call);
    }
  }
  return [...byId.values()];
}

// --- Cline, Roo Code, Kilo Code ---------------------------------------------

/** Estensioni derivate da Cline: stesso formato dei task. */
const CLINE_EXTENSIONS = ['saoudrizwan.claude-dev', 'rooveterinaryinc.roo-cline', 'kilocode.kilo-code'];

/** Provider in cui `tokensIn` esclude la cache, come nell'API Anthropic. */
const ANTHROPIC_PROTOCOL = new Set(['anthropic', 'bedrock', 'vertex', 'claude-code']);

export function defaultClineTaskDirs(): string[] {
  const dirs = [join(homedir(), '.cline', 'data', 'tasks')];
  for (const editor of knownEditors()) {
    const globalStorage = join(dirname(editor.settingsFile), 'globalStorage');
    for (const extension of CLINE_EXTENSIONS) dirs.push(join(globalStorage, extension, 'tasks'));
  }
  return dirs;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

const CWD_PATTERN = /Current Working Directory \((.+?)\)/;

/** La cartella del task compare nell'`environment_details` che Cline allega a ogni richiesta. */
function taskCwd(requests: string[], taskDir: string): string | undefined {
  for (const request of requests) {
    const match = CWD_PATTERN.exec(request);
    if (match) return match[1];
  }
  const history = readJson(join(taskDir, 'api_conversation_history.json'));
  const match = history ? CWD_PATTERN.exec(JSON.stringify(history)) : null;
  if (!match) return undefined;
  try {
    // Il path viene da un JSON serializzato: gli escape (`\\` su Windows) vanno sciolti.
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

interface ModelUsage {
  ts: number;
  model: string | null;
  provider: string | null;
}

function modelAt(history: ModelUsage[], ts: number): ModelUsage | undefined {
  let current: ModelUsage | undefined = history[0];
  for (const entry of history) if (entry.ts <= ts) current = entry;
  return current;
}

/** Chiamate di un task di Cline, una per `api_req_started` con dei contatori. */
export function readClineTask(taskDir: string): AgentCall[] {
  const messages = readJson(join(taskDir, 'ui_messages.json'));
  if (!Array.isArray(messages)) return [];
  const metadata = asObject(readJson(join(taskDir, 'task_metadata.json')));
  const history: ModelUsage[] = (Array.isArray(metadata?.model_usage) ? metadata.model_usage : [])
    .map((raw) => asObject(raw))
    .filter((entry): entry is Json => !!entry)
    .map((entry) => ({ ts: count(entry.ts), model: text(entry.model_id), provider: text(entry.model_provider_id) }))
    .sort((a, b) => a.ts - b.ts);

  const started: { ts: number; info: Json }[] = [];
  for (const raw of messages) {
    const message = asObject(raw);
    if (message?.say !== 'api_req_started' || typeof message.text !== 'string') continue;
    try {
      const info = asObject(JSON.parse(message.text));
      if (info) started.push({ ts: count(message.ts), info });
    } catch {
      // Testo non JSON: richiesta senza contatori.
    }
  }
  const cwd = taskCwd(started.map(({ info }) => (typeof info.request === 'string' ? info.request : '')), taskDir);
  const taskId = taskDir.split(/[\\/]/).pop()!;

  const calls: AgentCall[] = [];
  for (const { ts, info } of started) {
    const used = modelAt(history, ts);
    const cacheRead = count(info.cacheReads);
    const cacheWrite = count(info.cacheWrites);
    // Con i provider in stile OpenAI (LiteLLM compreso) `tokensIn` comprende la cache.
    const protocol = text(info.apiProtocol) ?? (used?.provider && ANTHROPIC_PROTOCOL.has(used.provider) ? 'anthropic' : 'openai');
    const tokensIn = count(info.tokensIn);
    const usage: TokenCounters = {
      inputTokens: protocol === 'anthropic' ? tokensIn : Math.max(0, tokensIn - cacheRead - cacheWrite),
      cachedInputTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      outputTokens: count(info.tokensOut),
    };
    if (ts === 0 || totalTokens(usage) === 0) continue;
    calls.push({
      tool: 'cline',
      requestId: `cline:${taskId}:${ts}`,
      occurredAt: new Date(ts),
      cwd,
      sessionId: taskId,
      models: used?.model ? [used.model] : [],
      provider: used?.provider ?? null,
      usage,
      durationMs: null,
    });
  }
  return calls;
}

export function readClineCalls(taskDirs = defaultClineTaskDirs(), modifiedSince?: Date): AgentCall[] {
  const calls: AgentCall[] = [];
  for (const dir of taskDirs) {
    for (const task of listDir(dir)) {
      const taskDir = join(dir, task);
      if (!touchedSince(join(taskDir, 'ui_messages.json'), modifiedSince)) continue;
      calls.push(...readClineTask(taskDir));
    }
  }
  return calls;
}

// --- opencode ---------------------------------------------------------------

export function defaultOpencodeDir(): string {
  return join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'), 'opencode');
}

/**
 * Normalizza un messaggio `assistant` di opencode.
 *
 * opencode separa gia' la cache dall'input fresco, per ogni provider.
 */
export function parseOpencodeMessage(
  raw: unknown,
  fallback: { id?: string; sessionId?: string; cwd?: string },
): AgentCall | undefined {
  const message = asObject(raw);
  if (message?.role !== 'assistant') return undefined;
  const tokens = asObject(message.tokens);
  const cache = asObject(tokens?.cache);
  const time = asObject(message.time);
  const id = text(message.id) ?? fallback.id;
  const created = count(time?.created);
  if (!tokens || !id || created === 0) return undefined;

  const usage: TokenCounters = {
    inputTokens: count(tokens.input),
    cachedInputTokens: count(cache?.read),
    cacheWriteTokens: count(cache?.write),
    // Il ragionamento e' fatturato come output.
    outputTokens: count(tokens.output) + count(tokens.reasoning),
  };
  if (totalTokens(usage) === 0) return undefined;
  const completed = count(time?.completed);

  return {
    tool: 'opencode',
    requestId: `opencode:${id}`,
    occurredAt: new Date(created),
    cwd: text(asObject(message.path)?.cwd) ?? fallback.cwd,
    sessionId: text(message.sessionID) ?? fallback.sessionId ?? 'opencode',
    models: [text(message.modelID)].filter((name): name is string => !!name),
    provider: text(message.providerID),
    usage,
    durationMs: completed > created ? completed - created : null,
  };
}

interface SqliteDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

/** `node:sqlite` si carica solo se serve: e' ancora sperimentale e lo segnala all'import. */
function openSqlite(file: string): SqliteDatabase | undefined {
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDatabase;
    };
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return undefined;
  }
}

/** Versioni recenti: tutto in `opencode.db`. */
function readOpencodeDb(file: string, since: Date | undefined): AgentCall[] {
  // Prima di caricare `node:sqlite`: chi non usa opencode non deve vederne l'avviso.
  if (!existsSync(file)) return [];
  const db = openSqlite(file);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT m.id, m.session_id, m.data, s.directory
         FROM message m JOIN session s ON s.id = m.session_id
         WHERE m.time_created >= ?`,
      )
      .all(since?.getTime() ?? 0) as { id: string; session_id: string; data: string; directory: string }[];
    const calls: AgentCall[] = [];
    for (const row of rows) {
      let data: unknown;
      try {
        data = JSON.parse(row.data);
      } catch {
        continue;
      }
      const call = parseOpencodeMessage(data, { id: row.id, sessionId: row.session_id, cwd: row.directory });
      if (call) calls.push(call);
    }
    return calls;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Versioni precedenti: un JSON per messaggio in `storage/message/<sessione>/`. */
function readOpencodeStorage(storage: string, since: Date | undefined): AgentCall[] {
  const sessionDirs = new Map<string, string>();
  const sessions = join(storage, 'session');
  for (const project of listDir(sessions)) {
    for (const name of listDir(join(sessions, project))) {
      const session = asObject(readJson(join(sessions, project, name)));
      if (typeof session?.id === 'string' && typeof session.directory === 'string') {
        sessionDirs.set(session.id, session.directory);
      }
    }
  }

  const calls: AgentCall[] = [];
  const messages = join(storage, 'message');
  for (const sessionId of listDir(messages)) {
    for (const name of listDir(join(messages, sessionId))) {
      const file = join(messages, sessionId, name);
      if (!name.endsWith('.json') || !touchedSince(file, since)) continue;
      const call = parseOpencodeMessage(readJson(file), {
        id: name.replace(/\.json$/, ''),
        sessionId,
        cwd: sessionDirs.get(sessionId),
      });
      if (call) calls.push(call);
    }
  }
  return calls;
}

export function readOpencodeCalls(dataDir = defaultOpencodeDir(), modifiedSince?: Date): AgentCall[] {
  const byId = new Map<string, AgentCall>();
  // Dopo la migrazione a SQLite i JSON possono restare: stessi id, una sola copia.
  for (const call of [
    ...readOpencodeStorage(join(dataDir, 'storage'), modifiedSince),
    ...readOpencodeDb(join(dataDir, 'opencode.db'), modifiedSince),
  ]) {
    byId.set(call.requestId, call);
  }
  return [...byId.values()];
}

/** Tutte le chiamate degli harness di terze parti salvate su questa macchina. */
export function readAgentCalls(modifiedSince?: Date): AgentCall[] {
  return [
    ...readClaudeCalls(undefined, modifiedSince),
    ...readClineCalls(undefined, modifiedSince),
    ...readOpencodeCalls(undefined, modifiedSince),
  ];
}
