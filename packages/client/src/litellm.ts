import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isMap, isSeq, parseDocument, type YAMLMap } from 'yaml';
import { proxyUrl } from './agentRuntime.js';
import { pointsToProxy } from './editors.js';

/** Provider di LiteLLM che parla con GitHub Copilot. */
const COPILOT_PREFIX = 'github_copilot/';

/** Una voce di `model_list` che LiteLLM inoltra a Copilot. */
export interface CopilotRoute {
  /** `model_name`: il nome con cui il client chiede il modello, anche con `*`. */
  alias: string;
  /** `litellm_params.model`, es. `github_copilot/claude-opus-5.5`. */
  model: string;
  apiBase: string | undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Legge le rotte verso Copilot; `undefined` se il file manca o non e' YAML. */
export function readCopilotRoutes(file: string): CopilotRoute[] | undefined {
  let content: string;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
  const document = parseDocument(content);
  if (document.errors.length > 0) return undefined;

  const list = document.toJS() as { model_list?: unknown } | null;
  if (!Array.isArray(list?.model_list)) return [];
  const routes: CopilotRoute[] = [];
  for (const entry of list.model_list as Record<string, unknown>[]) {
    const params = (entry?.litellm_params ?? {}) as Record<string, unknown>;
    const model = text(params.model);
    const alias = text(entry?.model_name);
    if (!model?.startsWith(COPILOT_PREFIX) || !alias) continue;
    routes.push({ alias, model, apiBase: text(params.api_base) });
  }
  return routes;
}

export interface RoutingResult {
  /** Rotte appena indirizzate al proxy. */
  updated: number;
  /** Gia' indirizzate al proxy. */
  already: number;
  /** Con un `api_base` diverso da Copilot: non si toccano, il proxy non saprebbe dove inoltrare. */
  foreign: CopilotRoute[];
  backup: string | undefined;
}

/** `api_base` lasciabile al proxy: assente o un host Copilot, che il proxy usa gia' come upstream. */
function replaceable(apiBase: string | undefined): boolean {
  if (!apiBase) return true;
  try {
    return /(^|\.)githubcopilot\.com$/.test(new URL(apiBase).hostname);
  } catch {
    return false;
  }
}

/**
 * Indirizza al proxy le rotte di LiteLLM verso Copilot, impostando `api_base`.
 *
 * Si modifica il documento YAML e non l'oggetto letto: commenti, ordine e
 * ancore del file restano com'erano.
 */
export function applyLiteLLMRouting(file: string, port: number): RoutingResult {
  const document = parseDocument(readFileSync(file, 'utf-8'));
  if (document.errors.length > 0) throw new Error(`${file} non e' YAML valido`);

  const result: RoutingResult = { updated: 0, already: 0, foreign: [], backup: undefined };
  const list = document.get('model_list');
  if (!isSeq(list)) return result;

  for (const item of list.items) {
    if (!isMap(item)) continue;
    const params = item.get('litellm_params');
    if (!isMap(params)) continue;
    const model = text(params.get('model'));
    if (!model?.startsWith(COPILOT_PREFIX)) continue;

    const apiBase = text(params.get('api_base'));
    if (apiBase && pointsToProxy(apiBase, port)) {
      result.already += 1;
      continue;
    }
    if (!replaceable(apiBase)) {
      result.foreign.push({ alias: text(item.get('model_name')) ?? model, model, apiBase });
      continue;
    }
    (params as YAMLMap).set('api_base', proxyUrl(port));
    result.updated += 1;
  }

  if (result.updated > 0) {
    result.backup = `${file}.bak`;
    copyFileSync(file, result.backup);
    writeFileSync(file, document.toString());
  }
  return result;
}

/** `--config <file>`, `--config=<file>` o `-c <file>` nella riga di comando di LiteLLM. */
export function configFromCommand(command: string): string | undefined {
  if (!/(^|[\s/])litellm(\.exe)?(\s|$)|litellm[\s/]proxy|-m\s+litellm/.test(command)) return undefined;
  return /(?:^|\s)(?:--config(?:=|\s+)|-c\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command)?.slice(1).find(Boolean);
}

function runningConfigs(): string[] {
  if (process.platform === 'win32') return [];
  try {
    const list = execFileSync('ps', ['-x', '-o', 'command='], { encoding: 'utf-8' });
    // Senza il cwd del processo un path relativo e' ambiguo: si prova dalla home.
    return list
      .split('\n')
      .map((line) => configFromCommand(line))
      .filter((file): file is string => !!file)
      .map((file) => (isAbsolute(file) ? file : resolve(homedir(), file)));
  } catch {
    return [];
  }
}

/** Configurazioni nei LaunchAgent che avviano LiteLLM. */
function launchAgentConfigs(): string[] {
  if (process.platform !== 'darwin') return [];
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.plist'));
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of files) {
    let content: string;
    try {
      content = readFileSync(join(dir, name), 'utf-8');
    } catch {
      continue;
    }
    if (!content.includes('litellm')) continue;
    const args = [...content.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]!);
    const index = args.findIndex((arg) => arg === '--config' || arg === '-c');
    const inline = args.find((arg) => arg.startsWith('--config='));
    const file = index >= 0 ? args[index + 1] : inline?.slice('--config='.length);
    if (file) found.push(file);
  }
  return found;
}

function conventionalConfigs(): string[] {
  const home = homedir();
  return [
    join(home, 'litellm_config.yaml'),
    join(home, 'litellm-config.yaml'),
    join(home, 'litellm', 'config.yaml'),
    join(home, '.litellm', 'config.yaml'),
    join(home, '.config', 'litellm', 'config.yaml'),
  ];
}

/**
 * File di configurazione di LiteLLM su questa macchina che hanno rotte verso
 * Copilot: quello del processo in esecuzione, dei LaunchAgent, o nei posti
 * consueti. LiteLLM non ha un percorso predefinito: si passa con `--config`.
 */
export function findLiteLLMConfigs(explicit: string[] = []): string[] {
  const candidates = [
    ...explicit,
    ...(process.env.CONFIG_FILE_PATH ? [process.env.CONFIG_FILE_PATH] : []),
    ...runningConfigs(),
    ...launchAgentConfigs(),
    ...conventionalConfigs(),
  ].map((file) => resolve(file));
  return [...new Set(candidates)].filter((file) => existsSync(file) && (readCopilotRoutes(file)?.length ?? 0) > 0);
}

/** Stessa normalizzazione del listino del collector, per confrontare nomi scritti in modo diverso. */
export function normalizeModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^[a-z0-9_-]+[/:]/, '')
    .replace(/[.\s_]+/g, '-')
    .replace(/-\d{4}-?\d{2}-?\d{2}$/, '');
}

/**
 * Riconosce le chiamate che LiteLLM ha mandato a Copilot dal nome del modello
 * chiesto dal client, e restituisce il modello Copilot con cui prezzarle.
 */
export function copilotModelMatcher(routes: CopilotRoute[]): (candidates: (string | null | undefined)[]) => string | undefined {
  const exact = new Map<string, string>();
  const wildcards: { prefix: string; model: string }[] = [];
  for (const route of routes) {
    if (route.alias.includes('*')) {
      wildcards.push({ prefix: route.alias.slice(0, route.alias.indexOf('*')), model: route.model });
      continue;
    }
    exact.set(normalizeModel(route.alias), route.model);
    // Alcuni client registrano il modello restituito, che e' quello Copilot.
    if (!route.model.includes('*')) exact.set(normalizeModel(route.model), route.model);
  }

  return (candidates) => {
    for (const candidate of candidates) {
      if (!candidate) continue;
      const model = exact.get(normalizeModel(candidate));
      if (model) return model;
      for (const wildcard of wildcards) {
        if (!candidate.startsWith(wildcard.prefix)) continue;
        const rest = candidate.slice(wildcard.prefix.length);
        return wildcard.model.includes('*') ? wildcard.model.replace('*', rest) : wildcard.model;
      }
    }
    return undefined;
  };
}
