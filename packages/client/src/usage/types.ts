import { totalInputTokens, type TokenCounters } from '@vidiemme/copilot-usage-contract';

/**
 * Contatori di token normalizzati, indipendenti dal protocollo upstream.
 *
 * Convenzione (allineata alla tariffazione GitHub Copilot):
 *  - inputTokens       = token di input NON serviti da cache
 *  - cachedInputTokens = token di input letti dalla cache
 *  - cacheWriteTokens  = token scritti in cache (solo modelli Anthropic)
 *  - outputTokens      = token generati
 *
 * Importante: le famiglie non sono sovrapposte. I parser che ricevono
 * un `prompt_tokens` comprensivo dei cached devono sottrarli.
 */
export type TokenUsage = TokenCounters;

export { totalInputTokens };

export interface ParsedUsage extends TokenUsage {
  /** Id modello dichiarato dalla risposta upstream, se presente. */
  model?: string;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

export function isUsageEmpty(usage: TokenUsage): boolean {
  return (
    usage.inputTokens === 0 &&
    usage.cachedInputTokens === 0 &&
    usage.cacheWriteTokens === 0 &&
    usage.outputTokens === 0
  );
}

function toInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export { toInt as coerceTokenCount };
