import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeHydraFusion, type UsageEventPayload } from '@vidiemme/copilot-usage-contract';
import type { Logger } from '../collector/forwarder.js';
import { sessionCalls, type SessionCursor } from '../reload/copilotCli.js';

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_PENDING = 10_000;

interface Pending {
  event: UsageEventPayload;
  addedAt: number;
  reportedFalse: boolean;
}

interface FileState {
  /** Byte successivo all'ultima riga completa gia' letta. */
  offset: number;
  cursor: SessionCursor;
  /** Dopo un salto si riparte a meta' di una riga, da scartare. */
  skipPartialLine: boolean;
}

function missingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Il record CLI viene scritto dopo la risposta HTTP. Il primo evento resta
 * indipendente dal log; un secondo invio con lo stesso requestId lo arricchisce.
 */
export class FusionCorrelator {
  private readonly pending = new Map<string, Pending>();
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private closed = false;
  private readonly warnedSessions = new Set<string>();
  private readonly files = new Map<string, FileState>();
  /** Il record CLI puo' precedere di poco la registrazione della richiesta nel proxy. */
  private readonly seen = new Map<string, { hydraFusion: boolean; at: number }>();

  constructor(
    private readonly stateDir: string,
    private readonly onResolved: (event: UsageEventPayload & { hydraFusion: boolean }) => void,
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly pollIntervalMs = 1000,
    private readonly waitMs = 15_000,
  ) {}

  track(event: UsageEventPayload): void {
    if (this.closed || event.hydraFusion != null) return;
    if (this.pending.size >= MAX_PENDING && !this.pending.has(event.requestId)) {
      this.logger.warn({ pending: this.pending.size }, 'troppe richieste in attesa del routing Fusion');
      return;
    }
    this.pending.set(event.requestId, { event, addedAt: Date.now(), reportedFalse: false });
    this.schedule(0);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
    this.pending.clear();
  }

  private schedule(delay: number): void {
    if (this.closed || this.timer || this.inFlight || this.pending.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const run = this.scan().catch((error: unknown) => {
        this.logger.warn({ err: error }, 'lettura dei metadati Fusion fallita');
      });
      this.inFlight = run;
      void run.then(() => {
        this.inFlight = undefined;
        this.schedule(this.pollIntervalMs);
      });
    }, delay);
    this.timer.unref();
  }

  private async scan(): Promise<void> {
    const now = Date.now();
    for (const [id, pending] of this.pending) {
      if (now - pending.addedAt >= this.waitMs) this.pending.delete(id);
    }
    if (this.pending.size === 0) return;

    let entries;
    try {
      entries = await readdir(this.stateDir, { withFileTypes: true });
    } catch (error) {
      if (!missingFile(error)) throw error;
      return;
    }

    const oldest = Math.min(...[...this.pending.values()].map(({ addedAt }) => addedAt)) - 5000;
    const present = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = join(this.stateDir, entry.name, 'events.jsonl');
      present.add(file);
      try {
        await this.readNewLines(file, entry.name, oldest);
      } catch (error) {
        if (!missingFile(error)) {
          this.logger.warn({ err: error, sessionId: entry.name }, 'lettura della sessione Copilot fallita');
        }
      }
    }
    for (const file of this.files.keys()) {
      if (!present.has(file)) this.files.delete(file);
    }
    for (const [requestId, seen] of this.seen) {
      if (now - seen.at >= this.waitMs) this.seen.delete(requestId);
    }

    for (const [requestId, pending] of this.pending) {
      const hydraFusion = this.seen.get(requestId)?.hydraFusion;
      if (hydraFusion === undefined) continue;
      if (hydraFusion) {
        this.pending.delete(requestId);
        this.onResolved({ ...pending.event, hydraFusion: true });
      } else if (!pending.reportedFalse) {
        pending.reportedFalse = true;
        this.onResolved({ ...pending.event, hydraFusion: false });
      }
    }
  }

  /**
   * Legge solo le righe complete aggiunte dall'ultima scansione. Il modello
   * selezionato resta noto finche' la lettura e' continua: dopo un salto torna
   * sconosciuto, cosi' non si deduce una selezione diretta senza prove.
   */
  private async readNewLines(file: string, sessionId: string, oldest: number): Promise<void> {
    const info = await stat(file);
    if (!info.isFile()) return;
    let state = this.files.get(file);
    if (state && info.size < state.offset) state = undefined;
    if (!state && info.mtimeMs < oldest) return;

    const from = state?.offset ?? 0;
    if (!state || info.size - from > MAX_LOG_BYTES) {
      const offset = Math.max(0, info.size - MAX_LOG_BYTES);
      state = { offset, cursor: {}, skipPartialLine: offset > 0 };
      this.files.set(file, state);
    }
    if (info.size === state.offset) return;

    const buffer = Buffer.alloc(info.size - state.offset);
    const handle = await open(file, 'r');
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset));
    } finally {
      await handle.close();
    }

    // Il newline e' un byte singolo anche in UTF-8: l'ultima riga incompleta si rilegge alla prossima scansione.
    const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (end < 0) return;
    const lines = buffer.subarray(0, end).toString('utf-8').split('\n');
    state.offset += end + 1;
    if (state.skipPartialLine) {
      lines.shift();
      state.skipPartialLine = false;
    }

    const warnInvalid = (): void => {
      if (this.warnedSessions.has(sessionId)) return;
      this.warnedSessions.add(sessionId);
      this.logger.warn({ sessionId }, 'record Copilot non valido: routing non determinabile');
    };
    const now = Date.now();
    for (const call of sessionCalls(lines, '', sessionId, warnInvalid, state.cursor)) {
      const hydraFusion = mergeHydraFusion(this.seen.get(call.requestId)?.hydraFusion, call.hydraFusion);
      if (hydraFusion === null) continue;
      if (!this.seen.has(call.requestId) && this.seen.size >= MAX_PENDING) continue;
      this.seen.set(call.requestId, { hydraFusion, at: now });
    }
  }
}
