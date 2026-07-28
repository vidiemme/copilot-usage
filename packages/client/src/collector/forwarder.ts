import { appendFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { MAX_EVENTS_PER_BATCH, type UsageEventPayload } from '@vidiemme/copilot-usage-contract';
import type { ClientConfig } from '../config.js';

export interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/** Oltre questa soglia si scartano eventi per non far crescere la memoria del proxy. */
const MAX_QUEUE_LENGTH = 10_000;
/** Tetto agli eventi parcheggiati su disco: si tengono i piu' recenti. */
const MAX_SPOOL_EVENTS = 50_000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Inoltra gli eventi di consumo al servizio di raccolta.
 *
 * Il proxy non deve mai dipendere dalla raggiungibilita' del servizio: se la
 * rete manca o il collector e' in manutenzione, le richieste Copilot devono
 * continuare a passare e la misura non deve andare persa. Gli eventi non
 * consegnati finiscono quindi su un file di spool e vengono ritentati; la
 * chiave `requestId` rende i rinvii innocui, perche' il server deduplica.
 */
export class UsageForwarder {
  private queue: UsageEventPayload[] = [];
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;
  private dropped = 0;
  private readonly batchSize: number;
  private readonly spoolPath: string;
  private readonly sendingPath: string;

  constructor(
    private readonly config: ClientConfig,
    private readonly logger: Logger,
  ) {
    this.batchSize = Math.min(config.flushMaxBatch, MAX_EVENTS_PER_BATCH);
    this.spoolPath = config.spoolPath;
    this.sendingPath = `${config.spoolPath}.sending`;
  }

  start(): void {
    if (this.timer) return;
    // Un invio interrotto a meta' lascia indietro il file di lavoro: va
    // recuperato prima di ripartire, altrimenti quegli eventi resterebbero li'.
    // Entra nella catena, cosi' il primo flush lo trova gia' fatto.
    this.pending = this.recoverInterrupted().catch(() => {});
    this.timer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
    this.timer.unref();
  }

  enqueue(event: UsageEventPayload): void {
    if (this.queue.length >= MAX_QUEUE_LENGTH) {
      this.dropped += 1;
      if (this.dropped % 100 === 1) {
        this.logger.error({ dropped: this.dropped }, 'coda usage piena, eventi scartati');
      }
      return;
    }
    this.queue.push(event);
    if (this.queue.length >= this.batchSize) void this.flush();
  }

  /**
   * Gli invii sono serializzati: due flush concorrenti si contenderebbero lo
   * spool. Chi chiama attende il proprio turno, cosi' `close()` ha la garanzia
   * che al ritorno non sia rimasto nulla in volo.
   */
  async flush(): Promise<void> {
    const run = (this.pending ?? Promise.resolve()).then(() => this.runFlush());
    this.pending = run.catch(() => {});
    await run;
  }

  private async runFlush(): Promise<void> {
    try {
      await this.drainSpool();

      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchSize);
        if (!(await this.send(batch))) {
          await this.spool([...batch, ...this.queue.splice(0)]);
          return;
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, 'inoltro usage fallito');
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
    // Cio' che resta viene parcheggiato: lo riprendera' il prossimo avvio.
    if (this.queue.length > 0) await this.spool(this.queue.splice(0));
  }

  private async send(events: UsageEventPayload[]): Promise<boolean> {
    if (events.length === 0) return true;

    let response: Response;
    try {
      response = await fetch(this.config.collectorUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.collectorToken}`,
        },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(this.config.collectorTimeoutMs),
      });
    } catch (error) {
      this.logger.warn({ err: error, events: events.length }, 'collector irraggiungibile');
      return false;
    }

    if (response.ok) return true;

    // Un 4xx non si risolve ritentando: il payload e' rifiutato o le
    // credenziali sono sbagliate. Tenerlo nello spool bloccherebbe tutto il
    // resto della coda, quindi si scarta e si segnala.
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    this.logger.error(
      { status: response.status, events: events.length, permanent },
      permanent ? 'collector ha rifiutato gli eventi' : 'collector non disponibile',
    );
    return permanent;
  }

  private async drainSpool(): Promise<void> {
    try {
      await rename(this.spoolPath, this.sendingPath);
    } catch {
      return;
    }

    const events = await this.readEvents(this.sendingPath);
    const batches = chunk(events, this.batchSize);

    for (let index = 0; index < batches.length; index += 1) {
      if (await this.send(batches[index]!)) continue;
      await this.spool(batches.slice(index).flat());
      break;
    }

    await rm(this.sendingPath, { force: true });
  }

  private async recoverInterrupted(): Promise<void> {
    const events = await this.readEvents(this.sendingPath);
    if (events.length === 0) {
      await rm(this.sendingPath, { force: true });
      return;
    }
    this.logger.warn({ events: events.length }, 'ripresi eventi da un invio interrotto');
    await this.spool(events);
    await rm(this.sendingPath, { force: true });
  }

  private async readEvents(path: string): Promise<UsageEventPayload[]> {
    let content: string;
    try {
      content = await readFile(path, 'utf-8');
    } catch {
      return [];
    }

    const events: UsageEventPayload[] = [];
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        events.push(JSON.parse(line) as UsageEventPayload);
      } catch {
        // Riga troncata da un arresto brusco: si scarta solo quella.
      }
    }
    return events;
  }

  private async spool(events: UsageEventPayload[]): Promise<void> {
    if (events.length === 0) return;
    const lines = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

    try {
      const size = await stat(this.spoolPath).then(
        (info) => info.size,
        () => 0,
      );
      if (size === 0) {
        await writeFile(this.spoolPath, lines, { mode: 0o600 });
      } else {
        await appendFile(this.spoolPath, lines);
      }
      await this.trimSpool();
    } catch (error) {
      this.logger.error({ err: error, events: events.length }, 'scrittura dello spool fallita');
    }
  }

  private async trimSpool(): Promise<void> {
    const events = await this.readEvents(this.spoolPath);
    if (events.length <= MAX_SPOOL_EVENTS) return;

    const kept = events.slice(-MAX_SPOOL_EVENTS);
    this.logger.error(
      { dropped: events.length - kept.length },
      "spool oltre il limite, scartati gli eventi piu' vecchi",
    );
    await writeFile(this.spoolPath, `${kept.map((event) => JSON.stringify(event)).join('\n')}\n`, {
      mode: 0o600,
    });
  }
}
