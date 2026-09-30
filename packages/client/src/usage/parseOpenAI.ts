import { coerceTokenCount, type ParsedUsage } from './types.js';

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null ? (value as Json) : undefined;
}

/**
 * Estrae i token da un blocco `usage` in formato OpenAI / Copilot chat completions.
 *
 * Attenzione: `prompt_tokens` INCLUDE i `cached_tokens` (e, sui modelli che
 * lo fatturano, il cache write). Vanno sottratti, altrimenti quei token
 * verrebbero fatturati due volte (a tariffa piena e a tariffa cache).
 */
export function readOpenAIUsageBlock(usage: unknown): ParsedUsage | undefined {
  const u = asObject(usage);
  if (!u) return undefined;

  const promptTokens = coerceTokenCount(u.prompt_tokens ?? u.input_tokens);
  const promptDetails = asObject(u.prompt_tokens_details ?? u.input_tokens_details);
  const cachedTokens = coerceTokenCount(promptDetails?.cached_tokens);
  // Nome del campo non ancora stabile fra gateway: si accettano le varianti note.
  const cacheWriteTokens = coerceTokenCount(
    promptDetails?.cache_write_tokens ??
      promptDetails?.cache_creation_tokens ??
      u.cache_creation_input_tokens,
  );
  const outputTokens = coerceTokenCount(u.completion_tokens ?? u.output_tokens);

  return {
    inputTokens: Math.max(0, promptTokens - cachedTokens - cacheWriteTokens),
    cachedInputTokens: cachedTokens,
    cacheWriteTokens,
    outputTokens,
  };
}

/**
 * Accumulatore per uno stream OpenAI/Copilot.
 *
 * Chat completions: l'usage arriva in un chunk finale (richiede
 * `stream_options: { include_usage: true }`), e alcuni gateway lo ripetono su
 * piu' chunk: si tiene sempre l'ultimo blocco non vuoto.
 * Responses API: gli eventi `response.*` annidano tutto in `response`, e
 * l'usage compare in `response.completed` (o `incomplete` / `failed`).
 */
export class OpenAIUsageAccumulator {
  private usage: ParsedUsage | undefined;
  private model: string | undefined;

  handleEvent(payload: unknown): void {
    const event = asObject(payload);
    if (!event) return;

    const isResponsesEvent = typeof event.type === 'string' && event.type.startsWith('response.');
    const chunk = isResponsesEvent ? asObject(event.response) : event;
    if (!chunk) return;

    if (typeof chunk.model === 'string' && chunk.model.length > 0) {
      this.model = chunk.model;
    }

    if (chunk.usage === null || chunk.usage === undefined) return;
    const parsed = readOpenAIUsageBlock(chunk.usage);
    if (!parsed) return;
    if (
      parsed.inputTokens + parsed.cachedInputTokens + parsed.cacheWriteTokens + parsed.outputTokens ===
      0
    ) {
      return;
    }
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
