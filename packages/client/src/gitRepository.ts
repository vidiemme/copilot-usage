import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { RepositoryIdentity } from '@vidiemme/copilot-usage-contract';
import { sanitizeIdentifier } from './attribution.js';

export type { RepositoryIdentity };

const REMOTE_HEADER = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/;
const SECTION_HEADER = /^\s*\[/;
const URL_ENTRY = /^\s*url\s*=\s*(.+?)\s*$/;
const GITDIR_ENTRY = /^gitdir:\s*(.+)$/m;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_PROJECT_ID_LENGTH = 160;

/**
 * Individua la directory di metadati Git del progetto.
 *
 * In un worktree o in un submodule `.git` non e' una cartella ma un file che
 * punta altrove; per i worktree il puntatore finisce dentro `worktrees/<nome>`,
 * mentre la configurazione dei remote vive nella directory principale.
 */
function resolveGitDir(projectRoot: string): string | undefined {
  const gitPath = join(projectRoot, '.git');

  let stats;
  try {
    stats = statSync(gitPath);
  } catch {
    return undefined;
  }
  if (stats.isDirectory()) return gitPath;

  let pointer: string;
  try {
    pointer = readFileSync(gitPath, 'utf-8');
  } catch {
    return undefined;
  }

  const match = GITDIR_ENTRY.exec(pointer);
  if (!match) return undefined;

  const target = match[1]!.trim();
  const absolute = isAbsolute(target) ? target : resolve(projectRoot, target);
  const worktrees = absolute.indexOf(`${sep}worktrees${sep}`);
  return worktrees >= 0 ? absolute.slice(0, worktrees) : absolute;
}

/** Legge gli URL dei remote da un file di configurazione Git. */
function readRemotes(gitDir: string): Map<string, string> {
  const remotes = new Map<string, string>();

  let content: string;
  try {
    const configPath = join(gitDir, 'config');
    if (statSync(configPath).size > MAX_CONFIG_BYTES) return remotes;
    content = readFileSync(configPath, 'utf-8');
  } catch {
    return remotes;
  }

  let current: string | undefined;
  for (const line of content.split('\n')) {
    const header = REMOTE_HEADER.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    if (SECTION_HEADER.test(line)) {
      current = undefined;
      continue;
    }
    if (!current) continue;

    const entry = URL_ENTRY.exec(line);
    if (entry && !remotes.has(current)) remotes.set(current, entry[1]!);
  }

  return remotes;
}

/**
 * Scompone un URL di remote nei suoi segmenti, coprendo le forme in uso:
 * `git@host:gruppo/repo.git`, `ssh://git@host:22/gruppo/repo`,
 * `https://host/gruppo/sottogruppo/repo.git`, percorsi locali.
 */
export function parseRemoteUrl(raw: string): { host: string | null; segments: string[] } {
  const url = raw.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (url.length === 0) return { host: null, segments: [] };

  if (url.startsWith('/') || url.startsWith('.') || url.startsWith('file:')) {
    return { host: null, segments: [basename(url)] };
  }

  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(url);
  let host: string | null = null;
  let path: string;

  if (scheme) {
    const rest = scheme[1]!;
    const slash = rest.indexOf('/');
    if (slash < 0) return { host: null, segments: [] };
    host = rest.slice(0, slash).replace(/^.*@/, '').replace(/:\d+$/, '') || null;
    path = rest.slice(slash + 1);
  } else {
    // Forma scp: [utente@]host:percorso
    const scp = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(url);
    if (!scp) return { host: null, segments: [basename(url)] };
    host = scp[1]!;
    path = scp[2]!;
  }

  return { host, segments: path.split('/').filter((segment) => segment.length > 0) };
}

/**
 * Ricava l'identita' del progetto dal remote Git invece che dal nome della
 * cartella.
 *
 * Il nome della cartella lo sceglie chi clona ed e' quindi diverso da macchina
 * a macchina; il percorso sul server Git no. Conservare anche i gruppi parent
 * permette di aggregare in seguito per cliente, business unit o qualunque
 * livello della gerarchia, senza dover riclassificare a mano.
 */
export function readRepositoryIdentity(projectRoot: string): RepositoryIdentity {
  const fallbackName = sanitizeIdentifier(basename(projectRoot)) ?? 'unknown';
  const fallback: RepositoryIdentity = {
    projectId: fallbackName,
    host: null,
    groups: [],
    name: fallbackName,
    remoteUrl: null,
  };

  const gitDir = resolveGitDir(projectRoot);
  if (!gitDir) return fallback;

  const remotes = readRemotes(gitDir);
  const remoteUrl =
    remotes.get('origin') ?? remotes.get('upstream') ?? remotes.values().next().value;
  if (!remoteUrl) return fallback;

  const { host, segments } = parseRemoteUrl(remoteUrl);
  const clean = segments
    .map((segment) => sanitizeIdentifier(segment))
    .filter((segment): segment is string => segment !== undefined);
  if (clean.length === 0) return fallback;

  return {
    projectId: clean.join('/').slice(0, MAX_PROJECT_ID_LENGTH),
    host,
    groups: clean.slice(0, -1),
    name: clean[clean.length - 1]!,
    remoteUrl,
  };
}
