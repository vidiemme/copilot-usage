import { coerceTokenCount, EMPTY_USAGE, type ParsedUsage } from './types.js';

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null ? (value as Json) : undefined;
}

/**
 * Estrae i token da un blocco `usage` in formato Anthropic Messages API.
 *
 * In Anthropic `input_tokens` esclude gia' i token di cache, quindi non
 * serve alcuna sottrazione.
 */
export function readAnthropicUsageBlock(usage: unknown): ParsedUsage | undefined {
  const u = asObject(usage);
  if (!u) return undefined;
  return {
    inputTokens: coerceTokenCount(u.input_tokens),
    cachedInputTokens: coerceTokenCount(u.cache_read_input_tokens),
    cacheWriteTokens: coerceTokenCount(u.cache_creation_input_tokens),
    outputTokens: coerceTokenCount(u.output_tokens),
  };
}

/**
 * Accumulatore per uno stream Anthropic.
 *
 * Lo stream distribuisce l'informazione su due eventi:
 *  - `message_start` porta gli input token (definitivi) e un output parziale
 *  - `message_delta` porta gli output token cumulativi finali
 */
export class AnthropicUsageAccumulator {
  private usage: ParsedUsage = { ...EMPTY_USAGE };
  private seen = false;

  handleEvent(payload: unknown): void {
    const event = asObject(payload);
    if (!event) return;

    const type = typeof event.type === 'string' ? event.type : undefined;

    if (type === 'message_start') {
      const message = asObject(event.message);
      if (!message) return;
      const parsed = readAnthropicUsageBlock(message.usage);
      if (parsed) {
        this.usage = parsed;
        this.seen = true;
      }
      if (typeof message.model === 'string') this.usage.model = message.model;
      return;
    }

    if (type === 'message_delta') {
      const parsed = readAnthropicUsageBlock(event.usage);
      if (!parsed) return;
      this.seen = true;
      // I contatori di message_delta sono cumulativi: si sovrascrive solo
      // cio' che l'evento dichiara effettivamente.
      if (parsed.outputTokens > 0) this.usage.outputTokens = parsed.outputTokens;
      if (parsed.inputTokens > 0) this.usage.inputTokens = parsed.inputTokens;
      if (parsed.cachedInputTokens > 0) this.usage.cachedInputTokens = parsed.cachedInputTokens;
      if (parsed.cacheWriteTokens > 0) this.usage.cacheWriteTokens = parsed.cacheWriteTokens;
    }
  }

  result(): ParsedUsage | undefined {
    return this.seen ? { ...this.usage } : undefined;
  }
}

/** Risposta Anthropic non-streaming. */
export function parseAnthropicResponse(body: unknown): ParsedUsage | undefined {
  const root = asObject(body);
  if (!root) return undefined;
  const parsed = readAnthropicUsageBlock(root.usage);
  if (!parsed) return undefined;
  if (typeof root.model === 'string') parsed.model = root.model;
  return parsed;
}
