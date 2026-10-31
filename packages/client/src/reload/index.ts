import { readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  MAX_EVENTS_PER_BATCH,
  type RepositoryIdentity,
  type UsageEventPayload,
} from '@vidiemme/copilot-usage-contract';
import { chunk, collectorHeaders } from '../collector/forwarder.js';
import { pseudonymize, type ClientConfig } from '../config.js';
import { readRepositoryIdentity } from '../gitRepository.js';
import { configDir } from '../paths.js';
import { ProjectDetector } from '../projectDetector.js';
import { gitIdentity } from '../setupHelpers.js';
import { readCliCalls, type CliCall } from './copilotCli.js';
import { reconstructRounds, type RateTier } from './reconstruct.js';
import { readChatRequests, type ChatRequest } from './vscodeChat.js';

export type ReloadSource = 'copilot-cli' | 'vscode-chat';

export interface ReloadOptions {
  roots: string[];
  markers: string[];
  from?: Date | undefined;
  /** Esclusivo. */
  to?: Date | undefined;
}

export interface RateBook {
  creditUsd: number;
  /** `null` = modello che il collector non sa prezzare. */
  models: Map<string, { tiers: RateTier[] } | null>;
}

export interface ReloadPlan {
  events: UsageEventPayload[];
  /** Crediti addebitati per le chat incluse, per confronto con la dashboard. */
  chatCredits: number;
  /** Richieste di chat lette ma non caricabili, con il motivo. */
  skippedChat: { noBilling: number; unpriced: Map<string, number>; noRates: number };
  sources: Record<ReloadSource, number>;
}

export interface ReloadInputs {
  cliCalls: CliCall[];
  chatRequests: ChatRequest[];
}

/** Clienti con cui si presentano gli eventi ricaricati: la famiglia e' quella del traffico dal vivo. */
const CLIENT_NAMES: Record<ReloadSource, string> = {
  'copilot-cli': 'copilot/reload',
  'vscode-chat': 'GitHubCopilotChat/reload',
};

/**
 * Pseudonimo del developer per lo storico.
 *
 * Il proxy lo ricava dal token Copilot, che qui non c'e': si parte quindi
 * dall'identita' dichiarata. E' un id diverso da quello del traffico dal vivo,
 * ma il collector unisce i due sotto lo stesso nome visualizzato.
 */
export function developerIdFor(config: ClientConfig): string {
  const git = gitIdentity();
  const identity =
    config.developerEmail ??
    git.email ??
    config.developerName ??
    git.name ??
    `${userInfo().username}@${hostname()}`;
  return pseudonymize(`identity:${identity.toLowerCase()}`, config.developerIdSalt);
}

/** Su Windows i path non distinguono le maiuscole: VS Code salva `c:\...`, la home e' `C:\...`. */
function comparable(path: string): string {
  const absolute = resolve(path);
  return sep === '\\' ? absolute.toLowerCase() : absolute;
}

function inside(path: string, roots: string[]): boolean {
  const target = comparable(path);
  return roots.some((root) => {
    const base = comparable(root);
    return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
  });
}

function inRange(at: Date, options: ReloadOptions): boolean {
  return (!options.from || at >= options.from) && (!options.to || at < options.to);
}

/**
 * Collega una cartella di lavoro al suo repository.
 *
 * Una cartella sotto i root che non sta in nessun repository prende comunque
 * un'identita' dal nome: e' lo stesso ripiego del proxy.
 */
function projectResolver(options: ReloadOptions): (folders: string[]) => RepositoryIdentity | undefined {
  const detector = new ProjectDetector({
    roots: options.roots,
    markers: options.markers,
    stickyTtlMs: 0,
    maxScanBytes: 0,
  });
  return (folders) => {
    const candidates = folders.filter((folder) => inside(folder, options.roots));
    for (const folder of candidates) {
      const repository = detector.resolve(folder);
      if (repository) return repository;
    }
    return candidates[0] ? readRepositoryIdentity(candidates[0]) : undefined;
  };
}

/** Prepara gli eventi da caricare, senza toccare la rete. */
export function buildReloadPlan(
  inputs: ReloadInputs,
  options: ReloadOptions,
  developerId: string,
  rates: RateBook | undefined,
): ReloadPlan {
  const projectOf = projectResolver(options);
  const plan: ReloadPlan = {
    events: [],
    chatCredits: 0,
    skippedChat: { noBilling: 0, unpriced: new Map(), noRates: 0 },
    sources: { 'copilot-cli': 0, 'vscode-chat': 0 },
  };

  const base = (repository: RepositoryIdentity, source: ReloadSource) => ({
    developerId,
    developerSource: 'identity',
    projectId: repository.projectId,
    projectSource: 'workspace',
    repository,
    clientName: CLIENT_NAMES[source],
    streamed: false,
  });

  for (const call of inputs.cliCalls) {
    if (!inRange(call.occurredAt, options)) continue;
    const repository = projectOf([call.cwd]);
    if (!repository) continue;
    plan.events.push({
      ...base(repository, 'copilot-cli'),
      requestId: call.requestId,
      occurredAt: call.occurredAt.toISOString(),
      sessionId: call.sessionId,
      endpoint: call.endpoint ?? '/reload/copilot-cli',
      model: call.model,
      usage: call.usage,
      durationMs: call.durationMs,
    });
    plan.sources['copilot-cli'] += 1;
  }

  for (const request of inputs.chatRequests) {
    if (!inRange(request.roundTimes[0]!, options)) continue;
    const repository = projectOf(request.folders);
    if (!repository) continue;

    if (request.credits === null || request.promptTokens === null || request.completionTokens === null) {
      plan.skippedChat.noBilling += 1;
      continue;
    }
    if (!rates) {
      plan.skippedChat.noRates += 1;
      continue;
    }
    const rate = request.model ? rates.models.get(request.model) : undefined;
    const rounds = rate
      ? reconstructRounds(
          {
            rounds: request.roundTimes.length,
            promptTokens: request.promptTokens,
            completionTokens: request.completionTokens,
            credits: request.credits,
          },
          rate.tiers,
          rates.creditUsd,
        )
      : undefined;
    if (!rounds) {
      const model = request.model ?? 'sconosciuto';
      plan.skippedChat.unpriced.set(model, (plan.skippedChat.unpriced.get(model) ?? 0) + 1);
      continue;
    }

    rounds.forEach((usage, index) => {
      plan.events.push({
        ...base(repository, 'vscode-chat'),
        // Deterministico: rilanciare il caricamento non duplica nulla.
        requestId: `vscode-chat:${request.requestId}:${index}`,
        occurredAt: request.roundTimes[index]!.toISOString(),
        sessionId: request.sessionId,
        endpoint: '/reload/vscode-chat',
        model: request.model,
        usage,
        durationMs: null,
      });
    });
    plan.chatCredits += request.credits;
    plan.sources['vscode-chat'] += 1;
  }

  plan.events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  return plan;
}

/** Legge le sessioni salvate sulla macchina. */
export function readLocalSessions(options: ReloadOptions): ReloadInputs {
  return {
    cliCalls: readCliCalls(undefined, options.from),
    chatRequests: readChatRequests(undefined, options.from),
  };
}

function ratesUrl(collectorUrl: string): string {
  return new URL('rates', collectorUrl.replace(/\/+$/, '')).toString();
}

/** Tariffe dei modelli dal collector: le stesse con cui verranno prezzati gli eventi. */
export async function fetchRates(config: ClientConfig, models: string[]): Promise<RateBook> {
  const url = new URL(ratesUrl(config.collectorUrl));
  for (const model of models) url.searchParams.append('model', model);

  const response = await fetch(url, {
    headers: collectorHeaders(config),
    signal: AbortSignal.timeout(config.collectorTimeoutMs),
  });
  if (response.status === 404) {
    throw new Error("il collector non espone ancora /v1/rates: va aggiornato prima di caricare le chat di VS Code");
  }
  if (!response.ok) throw new Error(`il collector risponde ${response.status} alla richiesta del listino`);

  const body = (await response.json()) as {
    creditUsd: number;
    models: Record<string, { tiers: RateTier[] } | null>;
  };
  return { creditUsd: body.creditUsd, models: new Map(Object.entries(body.models)) };
}

export function chatModels(requests: ChatRequest[]): string[] {
  return [...new Set(requests.map((request) => request.model).filter((model): model is string => !!model))];
}

export interface SendResult {
  accepted: number;
  rejected: number;
  /** Eventi non consegnati per errore di rete o del servizio: basta rilanciare. */
  failed: number;
  error?: string;
}

/**
 * Invia gli eventi in batch, in ordine. Al primo errore si ferma: le chiavi
 * sono deterministiche e il collector deduplica, quindi rilanciare riprende
 * senza doppioni.
 */
export async function sendEvents(
  config: ClientConfig,
  events: UsageEventPayload[],
  onProgress?: (sent: number) => void,
): Promise<SendResult> {
  const result: SendResult = { accepted: 0, rejected: 0, failed: 0 };
  const batches = chunk(events, MAX_EVENTS_PER_BATCH);

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]!;
    let response: Response;
    try {
      response = await fetch(config.collectorUrl, {
        method: 'POST',
        headers: collectorHeaders(config),
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(config.collectorTimeoutMs),
      });
    } catch (error) {
      result.failed = batches.slice(index).flat().length;
      result.error = `collector irraggiungibile: ${(error as Error).message}`;
      return result;
    }

    if (!response.ok) {
      result.failed = batches.slice(index).flat().length;
      result.error = `il collector risponde ${response.status}`;
      return result;
    }

    const body = (await response.json().catch(() => ({}))) as { rejected?: unknown[] };
    const rejected = Array.isArray(body.rejected) ? body.rejected.length : 0;
    result.rejected += rejected;
    result.accepted += batch.length - rejected;
    onProgress?.(result.accepted + result.rejected);
  }
  return result;
}

/**
 * Primo avvio del proxy registrato nel suo log. Da li' in poi il traffico di
 * questa postazione e' probabilmente gia' nel collector.
 */
export function proxyFirstStart(logFile = join(configDir(), 'proxy.log')): Date | undefined {
  let content: string;
  try {
    content = readFileSync(logFile, 'utf-8');
  } catch {
    return undefined;
  }
  for (const line of content.split('\n')) {
    if (!line.includes('Server listening')) continue;
    try {
      const time = (JSON.parse(line) as { time?: unknown }).time;
      if (typeof time === 'number') return new Date(time);
    } catch {
      // Riga non JSON: si passa alla prossima.
    }
  }
  return undefined;
}
