import { findModelRate, rateCard, selectTier, tierLabel } from './rateCard.js';
import { totalInputTokens, type TokenCounters as TokenUsage } from '@vidiemme/copilot-usage-contract';

export interface CostBreakdown {
  /** Modello canonico della rate card, `null` se non riconosciuto. */
  canonicalModel: string | null;
  vendor: string | null;
  tier: string | null;
  rateCardVersion: string;
  costUsd: number;
  aiCredits: number;
  /** `false` quando il modello non e' in tabella: il costo vale 0 e va indagato. */
  priced: boolean;
}

const TOKENS_PER_UNIT = 1_000_000;

/**
 * Converte i token consumati in costo.
 *
 * La fascia tariffaria (default vs long context) e' scelta sul totale dei token
 * di input della singola richiesta, coerentemente con la colonna
 * "Threshold (input tokens)" della documentazione GitHub.
 */
export function computeCost(rawModel: string | undefined, usage: TokenUsage): CostBreakdown {
  const rate = findModelRate(rawModel);

  if (!rate) {
    return {
      canonicalModel: null,
      vendor: null,
      tier: null,
      rateCardVersion: rateCard.version,
      costUsd: 0,
      aiCredits: 0,
      priced: false,
    };
  }

  const tier = selectTier(rate, totalInputTokens(usage));

  const costUsd =
    (usage.inputTokens * tier.input +
      usage.cachedInputTokens * tier.cachedInput +
      usage.cacheWriteTokens * tier.cacheWrite +
      usage.outputTokens * tier.output) /
    TOKENS_PER_UNIT;

  return {
    canonicalModel: rate.key,
    vendor: rate.vendor,
    tier: tierLabel(rate, tier),
    rateCardVersion: rateCard.version,
    costUsd,
    aiCredits: costUsd / rateCard.creditUsd,
    priced: true,
  };
}
