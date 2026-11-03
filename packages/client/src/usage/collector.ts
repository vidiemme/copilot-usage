import { findCopilotUsage, type CopilotBilling } from './copilotUsage.js';
import { AnthropicUsageAccumulator, parseAnthropicResponse } from './parseAnthropic.js';
import { OpenAIUsageAccumulator, parseOpenAIResponse } from './parseOpenAI.js';
import { SseParser } from './sse.js';
import { EMPTY_USAGE, isUsageEmpty, type ParsedUsage } from './types.js';

/**
 * Unisce l'`usage` del protocollo con l'addebito GitHub.
 *
 * Quando GitHub elenca i token addebitati, quei contatori prevalgono: sono gli
 * stessi su cui ha calcolato l'importo, e sono gli unici che distinguono le
 * scritture in cache su `/chat/completions`.
 */
export function withBilling(
  parsed: ParsedUsage | undefined,
  billing: CopilotBilling | undefined,
): ParsedUsage | undefined {
  if (!billing) return parsed;
  const counters = billing.tokens && !isUsageEmpty(billing.tokens) ? billing.tokens : (parsed ?? EMPTY_USAGE);
  const model = parsed?.model ?? billing.model;
  return {
    inputTokens: counters.inputTokens,
    cachedInputTokens: counters.cachedInputTokens,
    cacheWriteTokens: counters.cacheWriteTokens,
    outputTokens: counters.outputTokens,
    ...(model ? { model } : {}),
    billedNanoAiu: billing.totalNanoAiu,
  };
}

/**
 * Raccoglitore di usage indipendente dal dialetto upstream.
 *
 * Il proxy non sa a priori se la risposta e' in formato Anthropic Messages o
 * OpenAI chat completions (dipende da come e' configurato l'upstream), quindi
 * alimenta entrambi gli accumulatori e tiene il primo che produce un risultato.
 * Gli eventi dell'uno sono inerti per l'altro, perche' le forme dei payload
 * non si sovrappongono.
 */
export class UsageCollector {
  private readonly anthropic = new AnthropicUsageAccumulator();
  private readonly openai = new OpenAIUsageAccumulator();
  private billing: CopilotBilling | undefined;
  private readonly sse: SseParser;
  private nonStreamChunks: Uint8Array[] = [];
  private nonStreamBytes = 0;

  /** Oltre questa soglia si smette di bufferizzare una risposta non-stream. */
  private static readonly MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

  constructor(private readonly streaming: boolean) {
    this.sse = new SseParser((payload) => {
      this.anthropic.handleEvent(payload);
      this.openai.handleEvent(payload);
      // L'importo e' cumulativo per la richiesta: vale l'ultimo riportato.
      this.billing = findCopilotUsage(payload) ?? this.billing;
    });
  }

  push(chunk: Uint8Array): void {
    if (this.streaming) {
      this.sse.push(chunk);
      return;
    }
    if (this.nonStreamBytes + chunk.byteLength > UsageCollector.MAX_BUFFERED_BYTES) return;
    this.nonStreamChunks.push(chunk);
    this.nonStreamBytes += chunk.byteLength;
  }

  finish(): ParsedUsage | undefined {
    if (this.streaming) {
      this.sse.end();
      return withBilling(this.anthropic.result() ?? this.openai.result(), this.billing);
    }

    if (this.nonStreamChunks.length === 0) return undefined;
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(this.nonStreamChunks).toString('utf-8'));
    } catch {
      return undefined;
    } finally {
      this.nonStreamChunks = [];
    }
    return withBilling(parseNonStreaming(body), findCopilotUsage(body));
  }
}

/**
 * Il parser Anthropic accetta qualsiasi `usage` e su un corpo OpenAI darebbe
 * zero token: il dialetto si riconosce dal tipo del messaggio o dai campi di
 * cache propri di Anthropic.
 */
function parseNonStreaming(body: unknown): ParsedUsage | undefined {
  const root = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined;
  const usage = typeof root?.usage === 'object' && root.usage !== null ? (root.usage as Record<string, unknown>) : {};
  const anthropic =
    root?.type === 'message' || 'cache_read_input_tokens' in usage || 'cache_creation_input_tokens' in usage;
  return anthropic ? parseAnthropicResponse(body) : parseOpenAIResponse(body);
}

/** Euristica: la risposta e' uno stream SSE? */
export function isStreamingResponse(contentType: string | undefined): boolean {
  return (contentType ?? '').toLowerCase().includes('text/event-stream');
}
