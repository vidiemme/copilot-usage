import type { ServerConfig } from '../config.js';
import type { RepositoryIdentity } from '@vidiemme/copilot-usage-contract';
import type { Db } from './db.js';

/** Sottoinsieme dell'interfaccia pino usato dal writer. */
export interface Logger {
  error: (obj: object, msg: string) => void;
}

export interface UsageEvent {
  occurredAt: Date;
  requestId: string;
  developerId: string;
  projectId: string;
  projectSource: string;
  developerSource: string;
  clientName: string | null;
  sessionId: string | null;
  endpoint: string;
  rawModel: string | null;
  canonicalModel: string | null;
  vendor: string | null;
  tier: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  rateCardVersion: string;
  costUsd: number;
  aiCredits: number;
  priced: boolean;
  streamed: boolean;
  durationMs: number | null;
  /**
   * Non e' una colonna di `usage_events`: alimenta l'anagrafica `projects`
   * quando il progetto e' stato riconosciuto da un repository locale.
   */
  repository?: RepositoryIdentity | undefined;
}

const COLUMNS = [
  'occurred_at',
  'request_id',
  'developer_id',
  'project_id',
  'project_source',
  'developer_source',
  'client_name',
  'session_id',
  'endpoint',
  'raw_model',
  'canonical_model',
  'vendor',
  'tier',
  'input_tokens',
  'cached_input_tokens',
  'cache_write_tokens',
  'output_tokens',
  'rate_card_version',
  'cost_usd',
  'ai_credits',
  'priced',
  'streamed',
  'duration_ms',
] as const;

/** Oltre questa soglia si scartano eventi per non far crescere la memoria del proxy. */
const MAX_QUEUE_LENGTH = 10_000;

/**
 * Scrittore batch: accoda gli eventi e li scarica su Postgres a intervalli
 * regolari. La scrittura non deve mai bloccare o rallentare il proxy, quindi
 * gli errori vengono loggati e non propagati al client.
 */
export class UsageWriter {
  private queue: UsageEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;
  private dropped = 0;

  constructor(
    private readonly db: Db,
    private readonly config: ServerConfig,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
    this.timer.unref();
  }

  enqueue(event: UsageEvent): void {
    if (this.queue.length >= MAX_QUEUE_LENGTH) {
      this.dropped += 1;
      if (this.dropped % 100 === 1) {
        this.logger.error({ dropped: this.dropped }, 'coda usage piena, eventi scartati');
      }
      return;
    }
    this.queue.push(event);
    if (this.queue.length >= this.config.flushMaxBatch) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.config.flushMaxBatch);

    try {
      await this.insert(batch);
      await this.trackProjects(batch);
      await this.trackUnknownModels(batch);
    } catch (error) {
      this.logger.error({ err: error, size: batch.length }, 'scrittura eventi usage fallita');
    } finally {
      this.flushing = false;
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.queue.length > 0) {
      const before = this.queue.length;
      await this.flush();
      if (this.queue.length >= before) break;
    }
  }

  private async insert(batch: UsageEvent[]): Promise<void> {
    const values: unknown[] = [];
    const rows: string[] = [];

    for (const event of batch) {
      const offset = values.length;
      rows.push(`(${COLUMNS.map((_, i) => `$${offset + i + 1}`).join(', ')})`);
      values.push(
        event.occurredAt,
        event.requestId,
        event.developerId,
        event.projectId,
        event.projectSource,
        event.developerSource,
        event.clientName,
        event.sessionId,
        event.endpoint,
        event.rawModel,
        event.canonicalModel,
        event.vendor,
        event.tier,
        event.inputTokens,
        event.cachedInputTokens,
        event.cacheWriteTokens,
        event.outputTokens,
        event.rateCardVersion,
        event.costUsd,
        event.aiCredits,
        event.priced,
        event.streamed,
        event.durationMs,
      );
    }

    await this.db.query(
      `INSERT INTO usage_events (${COLUMNS.join(', ')})
       VALUES ${rows.join(', ')}
       ON CONFLICT (request_id) DO NOTHING`,
      values,
    );
  }

  /** Mantiene aggiornata l'anagrafica dei repository visti sul traffico. */
  private async trackProjects(batch: UsageEvent[]): Promise<void> {
    const repositories = new Map<string, RepositoryIdentity>();
    for (const event of batch) {
      if (event.repository) repositories.set(event.repository.projectId, event.repository);
    }

    for (const repository of repositories.values()) {
      await this.db.query(
        `INSERT INTO projects (project_id, repo_host, repo_owner, repo_groups, repo_name, remote_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (project_id)
         DO UPDATE SET repo_host   = EXCLUDED.repo_host,
                       repo_owner  = EXCLUDED.repo_owner,
                       repo_groups = EXCLUDED.repo_groups,
                       repo_name   = EXCLUDED.repo_name,
                       remote_url  = EXCLUDED.remote_url,
                       last_seen   = NOW()`,
        [
          repository.projectId,
          repository.host,
          repository.groups[0] ?? null,
          repository.groups,
          repository.name,
          repository.remoteUrl,
        ],
      );
    }
  }

  private async trackUnknownModels(batch: UsageEvent[]): Promise<void> {
    const counts = new Map<string, number>();
    for (const event of batch) {
      if (event.priced || !event.rawModel) continue;
      counts.set(event.rawModel, (counts.get(event.rawModel) ?? 0) + 1);
    }
    if (counts.size === 0) return;

    for (const [model, occurrences] of counts) {
      await this.db.query(
        `INSERT INTO unknown_models (raw_model, occurrences)
         VALUES ($1, $2)
         ON CONFLICT (raw_model)
         DO UPDATE SET occurrences = unknown_models.occurrences + EXCLUDED.occurrences,
                       last_seen = NOW()`,
        [model, occurrences],
      );
    }
  }
}
