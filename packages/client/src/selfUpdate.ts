import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { CLIENT_PACKAGE, CLIENT_USER_AGENT, CLIENT_VERSION } from './version.js';

const REGISTRY_URL = 'https://registry.npmjs.org';
const HOUR_MS = 60 * 60 * 1000;
/**
 * Una versione pubblicata per errore, o da chi non doveva, si scopre di solito
 * entro qualche giorno: fino ad allora resta solo sulle postazioni aggiornate a mano.
 */
export const UPDATE_MIN_AGE_MS = 48 * HOUR_MS;
const CHECK_INTERVAL_MS = 6 * HOUR_MS;
/** Il primo controllo e' sfasato: le postazioni si accendono tutte alla stessa ora. */
const FIRST_CHECK_MIN_MS = 2 * 60_000;
const FIRST_CHECK_JITTER_MS = 8 * 60_000;
/** Riavviare durante una risposta in streaming la troncherebbe. */
const QUIET_MS = 30_000;
const IDLE_POLL_MS = 10_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

/** Il sottoinsieme del documento del registry che serve qui. */
export interface Packument {
  'dist-tags'?: { latest?: string };
  time?: Record<string, string>;
  versions?: Record<string, { deprecated?: string }>;
}

type Version = [number, number, number];

/** Solo versioni stabili: una prerelease non si installa mai da sola. */
function parseVersion(value: string | undefined): Version | undefined {
  const match = value ? /^(\d+)\.(\d+)\.(\d+)$/.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Patch piu' recente della stessa minor, pubblicata da almeno `UPDATE_MIN_AGE_MS`.
 *
 * Un cambio di minor puo' richiedere di rilanciare il setup e resta manuale.
 * Il limite su `latest` lascia il rollback a chi pubblica: riportare indietro
 * il dist-tag ferma l'aggiornamento verso la versione ritirata.
 */
export function pickPatchUpdate(packument: Packument, current: string, now = Date.now()): string | undefined {
  const installed = parseVersion(current);
  const latest = parseVersion(packument['dist-tags']?.latest);
  if (!installed || !latest) return undefined;

  let best: Version | undefined;
  let bestName: string | undefined;
  for (const [name, manifest] of Object.entries(packument.versions ?? {})) {
    const version = parseVersion(name);
    if (!version || version[0] !== installed[0] || version[1] !== installed[1]) continue;
    if (version[2] <= installed[2] || compareVersions(version, latest) > 0) continue;
    if (manifest.deprecated) continue;
    const published = Date.parse(packument.time?.[name] ?? '');
    if (!Number.isFinite(published) || now - published < UPDATE_MIN_AGE_MS) continue;
    if (!best || compareVersions(version, best) > 0) {
      best = version;
      bestName = name;
    }
  }
  return bestName;
}

export interface InstallTarget {
  /** Prefisso globale di npm che contiene il pacchetto in esecuzione. */
  prefix: string;
  packageDir: string;
  /** `npm-cli.js` dello stesso Node che esegue il proxy. */
  npmCli: string;
}

/**
 * Dove installare la nuova versione perche' il servizio la trovi.
 *
 * Con piu' versioni di Node (nvm, fnm, Homebrew...) ognuna ha il suo prefisso
 * globale, e il `node` della shell non e' necessariamente quello del servizio:
 * il prefisso si ricava dal percorso del pacchetto in esecuzione e si passa a
 * npm esplicitamente, e npm e' quello che accompagna il Node del servizio.
 * Non si cerca npm nel `PATH`: quello dei servizi e' minimo.
 */
export function installTarget(
  entry: string,
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): InstallTarget | { reason: string } {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (/[\\/]_npx[\\/]/.test(entry)) return { reason: 'eseguito con npx' };

  const packageDir = p.dirname(p.dirname(entry));
  const [scope, name] = CLIENT_PACKAGE.split('/');
  const globalRoot = p.dirname(p.dirname(packageDir));
  const layoutOk =
    p.basename(packageDir) === name &&
    p.basename(p.dirname(packageDir)) === scope &&
    p.basename(globalRoot) === 'node_modules' &&
    (platform === 'win32' || p.basename(p.dirname(globalRoot)) === 'lib');
  if (!layoutOk) return { reason: "non e' un'installazione globale di npm" };
  const prefix = platform === 'win32' ? p.dirname(globalRoot) : p.dirname(p.dirname(globalRoot));

  const nodeDir = p.dirname(execPath);
  const candidates =
    platform === 'win32'
      ? [p.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : [resolveLink(p.join(nodeDir, 'npm')), p.join(p.dirname(nodeDir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const npmCli = candidates.find(
    (candidate): candidate is string => candidate !== undefined && candidate.endsWith('.js') && existsSync(candidate),
  );
  if (!npmCli) return { reason: `npm non trovato accanto a ${execPath}` };

  try {
    accessSync(globalRoot, constants.W_OK);
  } catch {
    return { reason: `${globalRoot} non e' scrivibile senza privilegi di amministratore` };
  }
  return { prefix, packageDir, npmCli };
}

function resolveLink(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

function installedVersion(packageDir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf-8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

export interface UpdateStatus {
  enabled: boolean;
  /** Perche' non si aggiorna da solo, se `enabled` e' falso. */
  reason?: string;
  lastCheckAt?: string;
  /** Versione gia' installata, in attesa che il proxy sia inattivo per ripartire. */
  pending?: string;
  lastError?: string;
}

export interface SelfUpdaterOptions {
  /** Motivo per non aggiornarsi; assente se si puo'. */
  disabledReason?: string;
  /** Da quando il proxy e' inattivo; `undefined` se ha richieste in corso. */
  idleSince: () => number | undefined;
  /** Arresta il processo: lo rilancia il servizio, con il codice nuovo. */
  restart: () => void;
}

/**
 * Installa da solo le patch e poi termina, lasciando a launchd, systemd o al
 * supervisore Windows il riavvio: il servizio punta al percorso del pacchetto
 * globale, che resta lo stesso fra una versione e l'altra.
 */
export class SelfUpdater {
  private readonly target: InstallTarget | { reason: string };
  private timer: NodeJS.Timeout | undefined;
  private checking = false;
  private state: UpdateStatus;
  private log: FastifyBaseLogger | undefined;

  constructor(private readonly options: SelfUpdaterOptions) {
    this.target = options.disabledReason
      ? { reason: options.disabledReason }
      : installTarget(fileURLToPath(new URL('cli.js', import.meta.url)), process.execPath);
    this.state = 'reason' in this.target ? { enabled: false, reason: this.target.reason } : { enabled: true };
  }

  status(): UpdateStatus {
    return { ...this.state };
  }

  start(log: FastifyBaseLogger): void {
    this.log = log;
    if (!this.state.enabled) return;
    this.schedule(FIRST_CHECK_MIN_MS + Math.random() * FIRST_CHECK_JITTER_MS);
  }

  close(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => void this.check(), delay);
    this.timer.unref();
  }

  private async check(): Promise<void> {
    if (this.checking || 'reason' in this.target) return;
    this.checking = true;
    const target = this.target;
    try {
      this.state.lastCheckAt = new Date().toISOString();
      const version = pickPatchUpdate(await fetchPackument(), CLIENT_VERSION);
      if (version) {
        this.log?.info({ version }, 'aggiornamento automatico: installo la nuova versione');
        await install(target, version);
        this.state.pending = version;
        this.state.lastError = undefined;
        this.log?.info({ version }, 'aggiornamento installato: riparto appena il proxy e\' inattivo');
        this.waitForIdle();
        return;
      }
      this.state.lastError = undefined;
    } catch (error) {
      this.state.lastError = (error as Error).message;
      this.log?.warn({ err: error }, 'aggiornamento automatico non riuscito');
    } finally {
      this.checking = false;
    }
    this.schedule(CHECK_INTERVAL_MS);
  }

  private waitForIdle(): void {
    const since = this.options.idleSince();
    if (since !== undefined && Date.now() - since >= QUIET_MS) {
      this.options.restart();
      return;
    }
    this.timer = setTimeout(() => this.waitForIdle(), IDLE_POLL_MS);
    this.timer.unref();
  }
}

async function fetchPackument(): Promise<Packument> {
  const response = await fetch(`${REGISTRY_URL}/${CLIENT_PACKAGE.replace('/', '%2f')}`, {
    headers: { accept: 'application/json', 'user-agent': CLIENT_USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`il registry npm risponde ${response.status}`);
  return (await response.json()) as Packument;
}

async function install(target: InstallTarget, version: string): Promise<void> {
  const nodeDir = path.dirname(process.execPath);
  await promisify(execFile)(
    process.execPath,
    [target.npmCli, 'install', '--global', '--prefix', target.prefix, '--no-audit', '--no-fund', `${CLIENT_PACKAGE}@${version}`],
    {
      timeout: INSTALL_TIMEOUT_MS,
      windowsHide: true,
      // Gli script del pacchetto e npm stesso cercano `node` nel PATH.
      env: { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ''}` },
    },
  );
  const found = installedVersion(target.packageDir);
  if (found !== version) {
    throw new Error(`dopo l'installazione ${target.packageDir} contiene la ${found ?? '?'}, attesa la ${version}`);
  }
}
