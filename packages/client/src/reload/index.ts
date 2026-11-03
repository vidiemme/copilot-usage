import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
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
import { readAgentCalls, type AgentCall } from './agents.js';
import { readCliCalls, type CliCall } from './copilotCli.js';
import { reconstructRounds, type RateTier } from './reconstruct.js';
import { readChatRequests, type ChatRequest } from './vscodeChat.js';

export type ReloadSource = 'copilot-cli' | 'vscode-chat' | 'claude-code' | 'cline' | 'opencode';

/**
 * Quali chiamate degli harness di terze parti sono passate da Copilot. I loro
 * log non lo dicono: lo si ricava dalle rotte di LiteLLM verso Copilot.
 */
export interface AgentPolicy {
  /** Modello Copilot con cui prezzare la chiamata, o `undefined` se LiteLLM non la mandava a Copilot. */
  matcher?: ((models: string[]) => string | undefined) | undefined;
  /** Tutte le chiamate del periodo, senza filtro: chi carica sa che passavano da Copilot. */
  all?: boolean | undefined;
  /** Da qui LiteLLM passa dal proxy: il resto e' gia' misurato dal vivo. */
  measuredSince?: Date | undefined;
}

export interface ReloadOptions {
  roots: string[];
  markers: string[];
  from?: Date | undefined;
  /** Esclusivo. */
  to?: Date | undefined;
  agents?: AgentPolicy | undefined;
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
  /**
   * Chiamate e richieste del periodo senza un repository sotto i root: la
   * cartella di lavoro e' altrove (`folders`, con il conteggio) o non e' un
   * path locale (`noFolder`: finestra senza cartella, WSL, SSH, container).
   */
  skippedOutside: { folders: Map<string, number>; noFolder: number };
  /**
   * Chiamate degli harness escluse: con modelli che LiteLLM non mandava a
   * Copilot (per `strumento modello`), o gia' misurate dal proxy.
   */
  skippedAgents: { notRouted: Map<string, number>; measured: number };
  sources: Record<ReloadSource, number>;
}

export interface ReloadInputs {
  cliCalls: CliCall[];
  chatRequests: ChatRequest[];
  agentCalls?: AgentCall[];
}

/** Clienti con cui si presentano gli eventi ricaricati: la famiglia e' quella del traffico dal vivo. */
export const CLIENT_NAMES: Record<ReloadSource, string> = {
  'copilot-cli': 'copilot/reload',
  'vscode-chat': 'GitHubCopilotChat/reload',
  'claude-code': 'claude-code/reload',
  cline: 'cline/reload',
  opencode: 'opencode/reload',
};

/** Il provider nativo di opencode e Cline parla direttamente con Copilot. */
const COPILOT_PROVIDERS = new Set(['github-copilot', 'copilot']);

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

/** Livelli di sottocartelle in cui cercare il repository di una cartella che lo contiene. */
const NESTED_REPOSITORY_DEPTH = 2;
/** Tetto alle cartelle esaminate: una cartella aperta sulla home non deve costare una scansione del disco. */
const NESTED_SCAN_LIMIT = 500;

/**
 * Unico repository dentro una cartella, entro due livelli; `undefined` se non
 * ce n'e' nessuno o piu' d'uno. Un clone e i suoi worktree sono lo stesso
 * repository: conta il remote, non quante cartelle hanno `.git`. Le cartelle
 * nascoste e le dipendenze non contano: li' non vive il progetto su cui si lavora.
 */
export function singleNestedRepository(folder: string, markers: string[]): string | undefined {
  let found: { path: string; projectId: string } | undefined;
  let level = [folder];
  let visited = 0;

  for (let depth = 0; depth < NESTED_REPOSITORY_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const directory of level) {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if ((visited += 1) > NESTED_SCAN_LIMIT) return undefined;
        const child = join(directory, entry.name);
        if (markers.some((marker) => existsSync(join(child, marker)))) {
          const { projectId } = readRepositoryIdentity(child);
          // Due repository diversi: la cartella e' un contenitore, non si puo' scegliere.
          if (found && found.projectId !== projectId) return undefined;
          found ??= { path: child, projectId };
        } else {
          next.push(child);
        }
      }
    }
    level = next;
  }
  return found?.path;
}

/**
 * Collega una cartella di lavoro al suo repository.
 *
 * VS Code e' spesso aperto sulla cartella che contiene il clone (`redroom/`
 * con dentro `monorepo/`): le chat restano legate a quella, e risalendo non si
 * trova nessun repository. Se dentro ce n'e' uno solo, la chat e' sua. Una
 * cartella che non porta a nessun repository, o a piu' d'uno, prende
 * un'identita' dal nome: e' lo stesso ripiego del proxy.
 */
function projectResolver(options: ReloadOptions): (folders: string[]) => RepositoryIdentity | undefined {
  const detector = new ProjectDetector({
    roots: options.roots,
    markers: options.markers,
    stickyTtlMs: 0,
    maxScanBytes: 0,
  });
  // Molte richieste condividono la stessa cartella: la scansione si fa una volta.
  const nested = new Map<string, RepositoryIdentity | undefined>();
  // La home e i root contengono tutto: l'unico clone nei primi livelli (un SDK,
  // un tool) non dice nulla su cosa si stesse facendo.
  const containers = new Set([homedir(), ...options.roots].map(comparable));
  const nestedRepository = (folder: string): RepositoryIdentity | undefined => {
    if (containers.has(comparable(folder))) return undefined;
    if (!nested.has(folder)) {
      const repository = singleNestedRepository(folder, options.markers);
      nested.set(folder, repository ? readRepositoryIdentity(repository) : undefined);
    }
    return nested.get(folder);
  };

  return (folders) => {
    const candidates = folders.filter((folder) => inside(folder, options.roots));
    for (const folder of candidates) {
      const repository = detector.resolve(folder);
      if (repository) return repository;
    }
    for (const folder of candidates) {
      const repository = nestedRepository(folder);
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
    skippedOutside: { folders: new Map(), noFolder: 0 },
    skippedAgents: { notRouted: new Map(), measured: 0 },
    sources: { 'copilot-cli': 0, 'vscode-chat': 0, 'claude-code': 0, cline: 0, opencode: 0 },
  };

  const skipOutside = (folders: string[]) => {
    const folder = folders[0];
    if (!folder) {
      plan.skippedOutside.noFolder += 1;
      return;
    }
    plan.skippedOutside.folders.set(folder, (plan.skippedOutside.folders.get(folder) ?? 0) + 1);
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
    if (!repository) {
      skipOutside([call.cwd]);
      continue;
    }
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
    if (!repository) {
      skipOutside(request.folders);
      continue;
    }

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

  const agents = options.agents ?? {};
  for (const call of inputs.agentCalls ?? []) {
    if (!inRange(call.occurredAt, options)) continue;
    // Prima il provider: le chiamate che non passavano da Copilot non vanno
    // nemmeno contate fra quelle fuori dalle cartelle.
    const model = copilotModel(call, agents);
    if (model === undefined) {
      const key = `${call.tool} ${call.models[0] ?? 'modello sconosciuto'}`;
      plan.skippedAgents.notRouted.set(key, (plan.skippedAgents.notRouted.get(key) ?? 0) + 1);
      continue;
    }
    if (agents.measuredSince && call.occurredAt >= agents.measuredSince) {
      plan.skippedAgents.measured += 1;
      continue;
    }
    const repository = call.cwd ? projectOf([call.cwd]) : undefined;
    if (!repository) {
      skipOutside(call.cwd ? [call.cwd] : []);
      continue;
    }
    plan.events.push({
      ...base(repository, call.tool),
      requestId: call.requestId,
      occurredAt: call.occurredAt.toISOString(),
      sessionId: call.sessionId,
      endpoint: `/reload/${call.tool}`,
      model,
      usage: call.usage,
      durationMs: call.durationMs,
    });
    plan.sources[call.tool] += 1;
  }

  plan.events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  return plan;
}

/**
 * Modello Copilot di una chiamata di un harness; `undefined` se non passava da
 * Copilot, `null` se ci passava ma il modello non e' noto.
 */
function copilotModel(call: AgentCall, policy: AgentPolicy): string | null | undefined {
  const declared = call.models[0] ?? null;
  if (call.provider && COPILOT_PROVIDERS.has(call.provider)) return declared;
  const routed = policy.matcher?.(call.models);
  if (routed) return routed;
  return policy.all ? declared : undefined;
}

/** Legge le sessioni salvate sulla macchina. */
export function readLocalSessions(options: ReloadOptions): ReloadInputs {
  return {
    cliCalls: readCliCalls(undefined, options.from),
    chatRequests: readChatRequests(undefined, options.from),
    agentCalls: readAgentCalls(options.from),
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
  /** Eventi accolti ma precedenti alla retention del collector: non entrano nei report. */
  expired: number;
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
  const result: SendResult = { accepted: 0, rejected: 0, expired: 0, failed: 0 };
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

    const body = (await response.json().catch(() => ({}))) as { rejected?: unknown[]; expired?: unknown };
    const rejected = Array.isArray(body.rejected) ? body.rejected.length : 0;
    result.rejected += rejected;
    if (typeof body.expired === 'number') result.expired += body.expired;
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
