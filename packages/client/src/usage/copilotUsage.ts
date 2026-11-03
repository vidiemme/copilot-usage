import { coerceTokenCount, type TokenUsage } from './types.js';

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

/** Addebito che GitHub allega a ogni risposta, nel blocco `copilot_usage`. */
export interface CopilotBilling {
  /** `total_nano_aiu`: 1e9 nano-AIU = 1 AI credit. */
  totalNanoAiu: number;
  /** Contatori dalle righe `token_details`, presenti se GitHub le ha elencate. */
  tokens?: TokenUsage;
  /** Modello su cui GitHub ha addebitato i token. */
  model?: string;
}

const TOKEN_FIELDS: Record<string, keyof TokenUsage> = {
  input: 'inputTokens',
  cache_read: 'cachedInputTokens',
  cache_write: 'cacheWriteTokens',
  output: 'outputTokens',
};

/**
 * Legge il blocco `copilot_usage` di una risposta GitHub Copilot.
 *
 * Le righe di `token_details` usano la stessa convenzione dei nostri contatori
 * (input senza cache, letture, scritture, output). Sono anche l'unico posto
 * in cui `/chat/completions` riporta le scritture in cache dei modelli
 * Anthropic: l'`usage` standard le conta dentro `prompt_tokens`.
 */
export function readCopilotUsage(value: unknown): CopilotBilling | undefined {
  const block = asObject(value);
  if (!block) return undefined;
  const nano = block.total_nano_aiu;
  if (typeof nano !== 'number' || !Number.isFinite(nano) || nano < 0) return undefined;

  const billing: CopilotBilling = { totalNanoAiu: Math.round(nano) };
  if (!Array.isArray(block.token_details)) return billing;

  const tokens: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  let recognized = false;
  for (const item of block.token_details) {
    const detail = asObject(item);
    const field = typeof detail?.token_type === 'string' ? TOKEN_FIELDS[detail.token_type] : undefined;
    if (!detail || !field) continue;
    recognized = true;
    tokens[field] += coerceTokenCount(detail.token_count);
    if (!billing.model && typeof detail.model === 'string' && detail.model.length > 0) {
      billing.model = detail.model;
    }
  }
  if (recognized) billing.tokens = tokens;
  return billing;
}

/**
 * Cerca `copilot_usage` in un payload: al primo livello in tutti i dialetti
 * (risposta intera, chunk o evento SSE), e per prudenza anche dentro
 * `response` / `message`, dove i due protocolli annidano il resto.
 */
export function findCopilotUsage(payload: unknown): CopilotBilling | undefined {
  const root = asObject(payload);
  if (!root) return undefined;
  return (
    readCopilotUsage(root.copilot_usage) ??
    readCopilotUsage(asObject(root.response)?.copilot_usage) ??
    readCopilotUsage(asObject(root.message)?.copilot_usage)
  );
}
