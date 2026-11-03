import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownEditors } from '../editors.js';
import { fusionFromChatSelection } from '../usage/fusion.js';

/** Una richiesta di Copilot Chat come la conserva l'editor. */
export interface ChatRequest {
  requestId: string;
  /** Inizio di ciascun round, in ordine. */
  roundTimes: Date[];
  /** Cartelle del workspace in cui e' avvenuta la conversazione. */
  folders: string[];
  sessionId: string;
  model: string | null;
  hydraFusion?: boolean | null;
  promptTokens: number | null;
  completionTokens: number | null;
  credits: number | null;
  editor: string;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Riapplica il log delle modifiche con cui VS Code salva una sessione.
 *
 * Le versioni recenti non riscrivono il file a ogni messaggio: aggiungono righe
 * `{kind, k, v}` — 0 stato iniziale, 1 assegnazione al percorso `k`, 2 aggiunta
 * in coda (da `i` in poi, se presente), 3 rimozione. Le versioni piu' vecchie
 * salvano invece in `.json` un unico oggetto con lo stato completo.
 */
export function replaySession(content: string): Json | undefined {
  let state: unknown;
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) continue;
    let entry: Json | undefined;
    try {
      entry = asObject(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry) continue;

    if (entry.kind === 0) {
      state = entry.v;
      continue;
    }
    const path = Array.isArray(entry.k) ? (entry.k as (string | number)[]) : undefined;
    if (!path || path.length === 0 || state === undefined) continue;

    let target = state as Record<string | number, unknown>;
    let valid = true;
    for (const key of path.slice(0, -1)) {
      const next = target[key];
      if (typeof next !== 'object' || next === null) {
        valid = false;
        break;
      }
      target = next as Record<string | number, unknown>;
    }
    if (!valid) continue;
    const last = path[path.length - 1]!;

    if (entry.kind === 1) target[last] = entry.v;
    else if (entry.kind === 3) delete target[last];
    else if (entry.kind === 2) {
      const list = target[last];
      if (!Array.isArray(list)) continue;
      if (typeof entry.i === 'number') list.splice(entry.i);
      list.push(...(Array.isArray(entry.v) ? entry.v : [entry.v]));
    }
  }
  return asObject(state);
}

function uriToPath(uri: string): string | undefined {
  if (!uri.startsWith('file://')) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

/**
 * Cartelle di un workspace multi-root. Il file ammette commenti e virgole
 * finali, quindi non si passa da `JSON.parse`: bastano le voci `path`.
 */
function workspaceFolders(file: string): string[] {
  let content: string;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const folders: string[] = [];
  for (const match of content.matchAll(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const raw = JSON.parse(`"${match[1]}"`) as string;
    folders.push(isAbsolute(raw) ? raw : resolve(dirname(file), raw));
  }
  return folders;
}

/** Cartelle aperte nella finestra a cui appartiene uno storage di workspace. */
function storageFolders(storageDir: string): string[] {
  let descriptor: Json | undefined;
  try {
    descriptor = asObject(JSON.parse(readFileSync(join(storageDir, 'workspace.json'), 'utf-8')));
  } catch {
    return [];
  }
  if (typeof descriptor?.folder === 'string') {
    const folder = uriToPath(descriptor.folder);
    return folder ? [folder] : [];
  }
  if (typeof descriptor?.workspace === 'string') {
    const file = uriToPath(descriptor.workspace);
    return file ? workspaceFolders(file) : [];
  }
  return [];
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function chatRequest(raw: unknown, sessionId: string, folders: string[], editor: string): ChatRequest | undefined {
  const request = asObject(raw);
  if (!request || typeof request.requestId !== 'string') return undefined;
  const metadata = asObject(asObject(request.result)?.metadata) ?? {};
  const rounds = Array.isArray(metadata.toolCallRounds) ? metadata.toolCallRounds : [];

  // In una sessione biforcata le richieste copiate prendono come timestamp il
  // momento del fork: l'orario vero sopravvive solo nei round.
  const started = asNumber(request.timestamp);
  const roundTimes = rounds.map((round) => asNumber(asObject(round)?.timestamp));
  const first = roundTimes.find((time): time is number => time !== null) ?? started;
  if (first === null) return undefined;
  const times = (roundTimes.length > 0 ? roundTimes : [first]).map(
    (time, index) => new Date(time ?? first + index),
  );

  const resolved = typeof metadata.resolvedModel === 'string' ? metadata.resolvedModel : undefined;
  const selected = typeof request.modelId === 'string' ? request.modelId : undefined;

  return {
    requestId: request.requestId,
    roundTimes: times,
    folders,
    sessionId,
    model: resolved ?? selected ?? null,
    hydraFusion: fusionFromChatSelection(selected, resolved),
    promptTokens: asNumber(request.promptTokens) ?? asNumber(metadata.promptTokens),
    completionTokens: asNumber(request.completionTokens) ?? asNumber(metadata.outputTokens),
    credits: asNumber(request.copilotCredits),
    editor,
  };
}

/** Radici degli storage di workspace degli editor della famiglia VS Code. */
export function defaultStorageRoots(): { editor: string; path: string }[] {
  return knownEditors().map((editor) => ({
    editor: editor.name,
    path: join(dirname(editor.settingsFile), 'workspaceStorage'),
  }));
}

/**
 * Legge le richieste di Copilot Chat salvate dagli editor.
 *
 * Una stessa richiesta compare in piu' file quando una sessione viene
 * biforcata: si tiene una sola copia, con l'orario piu' antico.
 */
export function readChatRequests(
  roots = defaultStorageRoots(),
  modifiedSince?: Date,
): ChatRequest[] {
  const byId = new Map<string, ChatRequest>();

  for (const root of roots) {
    for (const storage of listDir(root.path)) {
      const storageDir = join(root.path, storage);
      const sessionsDir = join(storageDir, 'chatSessions');
      const files = listDir(sessionsDir).filter((name) => name.endsWith('.json') || name.endsWith('.jsonl'));
      if (files.length === 0) continue;
      const folders = storageFolders(storageDir);

      for (const name of files) {
        const file = join(sessionsDir, name);
        // Un file non toccato dall'inizio del periodo non puo' contenerne richieste.
        if (modifiedSince && statSync(file).mtime < modifiedSince) continue;

        let session: Json | undefined;
        try {
          const content = readFileSync(file, 'utf-8');
          session = name.endsWith('.jsonl') ? replaySession(content) : asObject(JSON.parse(content));
        } catch {
          continue;
        }
        const requests = Array.isArray(session?.requests) ? session.requests : [];
        const sessionId = typeof session?.sessionId === 'string' ? session.sessionId : name.replace(/\.jsonl?$/, '');

        for (const raw of requests) {
          const request = chatRequest(raw, sessionId, folders, root.editor);
          if (!request) continue;
          const known = byId.get(request.requestId);
          if (!known || request.roundTimes[0]! < known.roundTimes[0]!) byId.set(request.requestId, request);
        }
      }
    }
  }
  return [...byId.values()];
}
