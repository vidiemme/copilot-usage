import { existsSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { readRepositoryIdentity, type RepositoryIdentity } from './gitRepository.js';

export interface ProjectDetectorOptions {
  /** Cartelle sotto cui vivono i progetti: delimitano cosa e' lecito risolvere. */
  roots: string[];
  /** File o cartelle che marcano la radice di un progetto (tipicamente `.git`). */
  markers: string[];
  /** Durata dell'ereditarieta' del progetto sulle richieste senza path. */
  stickyTtlMs: number;
  /** Limite di corpo ispezionato, per non pagare scansioni su payload enormi. */
  maxScanBytes: number;
}

export interface DetectedProject {
  repository: RepositoryIdentity;
  /** `workspace` = dedotto dai path nella richiesta; `session` = ereditato. */
  source: 'workspace' | 'session';
}

const MAX_CACHE_ENTRIES = 5_000;
const MAX_STICKY_ENTRIES = 1_000;
/** Un remote aggiunto o cambiato deve vedersi senza riavviare il proxy. */
const CACHE_TTL_MS = 10 * 60_000;

const IS_WINDOWS = sep === '\\';

/** Separatore nel testo: `/`, `\`, oppure le forme escapate in JSON (`\\`, `\/`). */
const SEPARATOR = '[\\\\/]+';
/** Caratteri ammessi in un segmento di path, esclusi i separatori. */
const SEGMENT_CHAR = '[^\\s"\'`,;:*?<>|()\\[\\]{}\\\\/]';
/** Un segmento puo' contenere spazi singoli: `My Project`. */
const SEGMENT = `${SEGMENT_CHAR}+(?: ${SEGMENT_CHAR}+)*`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRoot(root: string): string {
  return normalizePath(root.trim()).replace(/[\\/]+$/, '');
}

/** Il root puo' comparire come path nativo o dentro un URI `file://` percent-encoded. */
function rootPattern(root: string): string {
  return root
    .split(/[\\/]+/)
    .map((part) => {
      const drive = /^([A-Za-z]):$/.exec(part);
      if (drive) {
        const letter = drive[1]!;
        return `[${letter.toUpperCase()}${letter.toLowerCase()}](?::|%3[Aa])`;
      }
      return escapeRegExp(part).replace(/ /g, '(?: |%20)');
    })
    .join(SEPARATOR);
}

function decodePercent(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Riporta un path trovato nel testo alla forma nativa della piattaforma. */
function normalizePath(value: string): string {
  const path = decodePercent(value).replace(/[\\/]+/g, sep);
  // Da `file:///c:/Users/...` resta `\c:\Users\...`.
  return IS_WINDOWS ? path.replace(/^\\(?=[A-Za-z]:)/, '') : path;
}

function startsWithRoot(path: string, root: string): boolean {
  const head = path.slice(0, root.length);
  const same = IS_WINDOWS ? head.toLowerCase() === root.toLowerCase() : head === root;
  return same && path[root.length] === sep;
}

/**
 * Deduce il progetto di appartenenza di una richiesta dai path assoluti che
 * questa cita.
 *
 * Le richieste di Copilot Chat trasportano il contesto di lavoro: file aperti,
 * riferimenti espliciti, risultati degli strumenti dell'agente. Tutti nominano
 * file reali sul disco. Risalendo da quei path fino al marker di progetto piu'
 * vicino si ottiene l'attribuzione senza chiedere al developer di configurare
 * nulla per ogni repository, e senza conservare il contenuto della richiesta:
 * dei path si tiene solo l'identita' del repository.
 */
export class ProjectDetector {
  private readonly roots: string[];
  private readonly markers: string[];
  private readonly stickyTtlMs: number;
  private readonly maxScanBytes: number;
  private readonly pattern: RegExp | undefined;
  /** Path candidato -> repository risolto (o `null` se fuori da ogni progetto). */
  private readonly cache = new Map<
    string,
    { repository: RepositoryIdentity | null; expiresAt: number }
  >();
  private readonly sticky = new Map<string, { repository: RepositoryIdentity; expiresAt: number }>();

  constructor(options: ProjectDetectorOptions) {
    // I root piu' lunghi vanno provati per primi: con root annidati vince il
    // piu' specifico.
    this.roots = options.roots
      .map(normalizeRoot)
      .filter((root) => root.length > 0)
      .sort((a, b) => b.length - a.length);
    this.markers = options.markers;
    this.stickyTtlMs = options.stickyTtlMs;
    this.maxScanBytes = options.maxScanBytes;

    this.pattern =
      this.roots.length > 0
        ? new RegExp(
            `(?:${this.roots.map(rootPattern).join('|')})(?:${SEPARATOR}${SEGMENT})+`,
            'g',
          )
        : undefined;
  }

  get enabled(): boolean {
    return this.pattern !== undefined;
  }

  /**
   * @param sessionKey chiave della finestra/conversazione, usata per ereditare
   *   il progetto nelle richieste che non citano file (titoli, domande secche).
   */
  detect(body: Buffer, sessionKey: string, now = Date.now()): DetectedProject | undefined {
    const repository = this.fromBody(body, now);

    if (repository) {
      this.remember(sessionKey, repository, now);
      return { repository, source: 'workspace' };
    }

    const previous = this.sticky.get(sessionKey);
    if (previous && previous.expiresAt > now) {
      return { repository: previous.repository, source: 'session' };
    }

    return undefined;
  }

  private fromBody(body: Buffer, now: number): RepositoryIdentity | undefined {
    if (!this.pattern || body.length === 0) return undefined;

    const text = body.toString('utf-8', 0, Math.min(body.length, this.maxScanBytes));
    const candidates = new Set<string>();

    this.pattern.lastIndex = 0;
    for (let match = this.pattern.exec(text); match; match = this.pattern.exec(text)) {
      candidates.add(normalizePath(match[0]));
    }
    if (candidates.size === 0) return undefined;

    // Vince il progetto piu' citato: un riferimento isolato a un file di un
    // altro repository non deve dirottare l'attribuzione.
    const scores = new Map<string, number>();
    let best: RepositoryIdentity | undefined;
    let bestScore = 0;

    for (const candidate of candidates) {
      const repository = this.projectFor(candidate, now);
      if (!repository) continue;

      const score = (scores.get(repository.projectId) ?? 0) + 1;
      scores.set(repository.projectId, score);
      if (score > bestScore) {
        best = repository;
        bestScore = score;
      }
    }

    return best;
  }

  /** Risale dal path fino al primo marker di progetto, senza uscire dal root. */
  private projectFor(candidate: string, now: number): RepositoryIdentity | undefined {
    const cached = this.cache.get(candidate);
    if (cached && cached.expiresAt > now) return cached.repository ?? undefined;

    const root = this.roots.find((item) => startsWithRoot(candidate, item));

    let result: RepositoryIdentity | undefined;
    let directory = candidate;
    while (root && directory.length > root.length) {
      if (this.markers.some((marker) => existsSync(`${directory}${sep}${marker}`))) {
        result = readRepositoryIdentity(directory);
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }

    if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
    this.cache.set(candidate, { repository: result ?? null, expiresAt: now + CACHE_TTL_MS });
    return result;
  }

  private remember(sessionKey: string, repository: RepositoryIdentity, now: number): void {
    if (this.sticky.size >= MAX_STICKY_ENTRIES) {
      for (const [key, entry] of this.sticky) {
        if (entry.expiresAt <= now) this.sticky.delete(key);
      }
      if (this.sticky.size >= MAX_STICKY_ENTRIES) this.sticky.clear();
    }
    this.sticky.set(sessionKey, { repository, expiresAt: now + this.stickyTtlMs });
  }
}
