import { coerceTokenCount, type ParsedUsage } from './types.js';

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null ? (value as Json) : undefined;
}

/**
 * Estrae i token da un blocco `usage` in formato OpenAI / Copilot chat completions.
 *
 * Attenzione: `prompt_tokens` INCLUDE i `cached_tokens`. Vanno sottratti,
 * altrimenti i token in cache verrebbero fatturati due volte (a tariffa piena
 * e a tariffa cache).
 */
export function readOpenAIUsageBlock(usage: unknown): ParsedUsage | undefined {
  const u = asObject(usage);
  if (!u) return undefined;

  const promptTokens = coerceTokenCount(u.prompt_tokens ?? u.input_tokens);
  const promptDetails = asObject(u.prompt_tokens_details ?? u.input_tokens_details);
  const cachedTokens = coerceTokenCount(promptDetails?.cached_tokens);
  const outputTokens = coerceTokenCount(u.completion_tokens ?? u.output_tokens);

  return {
    inputTokens: Math.max(0, promptTokens - cachedTokens),
    cachedInputTokens: cachedTokens,
    // Il formato OpenAI non espone il cache write: resta a zero.
    cacheWriteTokens: 0,
    outputTokens,
  };
}

/**
 * Accumulatore per uno stream OpenAI/Copilot.
 *
 * L'usage arriva tipicamente in un unico chunk finale (richiede
 * `stream_options: { include_usage: true }`). Alcuni gateway lo ripetono su
 * piu' chunk: si tiene sempre l'ultimo blocco non vuoto.
 */
export class OpenAIUsageAccumulator {
  private usage: ParsedUsage | undefined;
  private model: string | undefined;

  handleEvent(payload: unknown): void {
    const chunk = asObject(payload);
    if (!chunk) return;

    if (typeof chunk.model === 'string' && chunk.model.length > 0) {
      this.model = chunk.model;
    }

    if (chunk.usage === null || chunk.usage === undefined) return;
    const parsed = readOpenAIUsageBlock(chunk.usage);
    if (!parsed) return;
    if (parsed.inputTokens + parsed.cachedInputTokens + parsed.outputTokens === 0) return;
    this.usage = parsed;
  }

  result(): ParsedUsage | undefined {
    if (!this.usage) return undefined;
    return { ...this.usage, model: this.usage.model ?? this.model };
  }
}

/** Risposta OpenAI/Copilot non-streaming. */
export function parseOpenAIResponse(body: unknown): ParsedUsage | undefined {
  const root = asObject(body);
  if (!root) return undefined;
  const parsed = readOpenAIUsageBlock(root.usage);
  if (!parsed) return undefined;
  if (typeof root.model === 'string') parsed.model = root.model;
  return parsed;
}
