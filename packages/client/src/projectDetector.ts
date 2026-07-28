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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRoot(root: string): string {
  return root.trim().replace(/[\\/]+$/, '');
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
  private readonly cache = new Map<string, RepositoryIdentity | null>();
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
            `(?:${this.roots.map(escapeRegExp).join('|')})(?:/[^\\s"'\`,;:*?<>|()\\[\\]{}\\\\]+)+`,
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
    const repository = this.fromBody(body);

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

  private fromBody(body: Buffer): RepositoryIdentity | undefined {
    if (!this.pattern || body.length === 0) return undefined;

    const text = body.toString('utf-8', 0, Math.min(body.length, this.maxScanBytes));
    const candidates = new Set<string>();

    this.pattern.lastIndex = 0;
    for (let match = this.pattern.exec(text); match; match = this.pattern.exec(text)) {
      candidates.add(match[0]);
    }
    if (candidates.size === 0) return undefined;

    // Vince il progetto piu' citato: un riferimento isolato a un file di un
    // altro repository non deve dirottare l'attribuzione.
    const scores = new Map<string, number>();
    let best: RepositoryIdentity | undefined;
    let bestScore = 0;

    for (const candidate of candidates) {
      const repository = this.projectFor(candidate);
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
  private projectFor(candidate: string): RepositoryIdentity | undefined {
    const cached = this.cache.get(candidate);
    if (cached !== undefined) return cached ?? undefined;

    const root = this.roots.find(
      (item) => candidate.startsWith(item) && candidate[item.length] === '/',
    );

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
    this.cache.set(candidate, result ?? null);
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
