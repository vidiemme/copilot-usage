import { AnthropicUsageAccumulator, parseAnthropicResponse } from './parseAnthropic.js';
import { OpenAIUsageAccumulator, parseOpenAIResponse } from './parseOpenAI.js';
import { SseParser } from './sse.js';
import type { ParsedUsage } from './types.js';

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
  private readonly sse: SseParser;
  private nonStreamChunks: Uint8Array[] = [];
  private nonStreamBytes = 0;

  /** Oltre questa soglia si smette di bufferizzare una risposta non-stream. */
  private static readonly MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

  constructor(private readonly streaming: boolean) {
    this.sse = new SseParser((payload) => {
      this.anthropic.handleEvent(payload);
      this.openai.handleEvent(payload);
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
      return this.anthropic.result() ?? this.openai.result();
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
    return parseAnthropicResponse(body) ?? parseOpenAIResponse(body);
  }
}

/** Euristica: la risposta e' uno stream SSE? */
export function isStreamingResponse(contentType: string | undefined): boolean {
  return (contentType ?? '').toLowerCase().includes('text/event-stream');
}
