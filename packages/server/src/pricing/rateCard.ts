import rates from './rates.json' with { type: 'json' };

export interface RateTier {
  /** Soglia superiore (inclusa) di input token per questa fascia. `null` = illimitata. */
  maxInputTokens: number | null;
  /** Prezzi in USD per 1M token. */
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export interface ModelRate {
  model: string;
  key: string;
  vendor: string;
  note?: string;
  /** Data oltre la quale la tariffa non e' piu' garantita (es. prezzi promozionali). */
  validUntil?: string;
  aliases?: string[];
  tiers: RateTier[];
}

export interface RateCard {
  version: string;
  source: string;
  creditUsd: number;
  models: ModelRate[];
}

export const rateCard: RateCard = rates as RateCard;

/**
 * Normalizza un id modello in una chiave confrontabile.
 *
 * Gestisce le differenze di formato tra i vari client:
 *  - Copilot        `claude-opus-4.5`, `gpt-5.4-mini`
 *  - Anthropic API  `claude-opus-4-5-20260101`
 *  - varianti con suffissi `-preview`, `-latest`, prefisso vendor `anthropic/`
 */
export function normalizeModelId(rawModel: string): string {
  let value = rawModel.trim().toLowerCase();

  // Prefisso vendor: `anthropic/claude-...`, `copilot:gpt-...`
  value = value.replace(/^[a-z0-9_-]+[/:]/, '');

  // I punti di versione diventano trattini: 4.5 -> 4-5
  value = value.replace(/[.\s_]+/g, '-');

  // Suffisso data: -20260101 oppure -2026-01-01
  value = value.replace(/-\d{4}-?\d{2}-?\d{2}$/, '');

  // Suffissi di canale non tariffabili
  value = value.replace(/-(preview|latest|ga|stable|beta|thinking)$/g, '');

  return value.replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}

const index = new Map<string, ModelRate>();
for (const entry of rateCard.models) {
  index.set(normalizeModelId(entry.key), entry);
  for (const alias of entry.aliases ?? []) index.set(normalizeModelId(alias), entry);
}

export function findModelRate(rawModel: string | undefined): ModelRate | undefined {
  if (!rawModel) return undefined;
  return index.get(normalizeModelId(rawModel));
}

/**
 * Seleziona la fascia tariffaria in base al volume di input della richiesta.
 * Le fasce sono valutate in ordine crescente di soglia.
 */
export function selectTier(rate: ModelRate, totalInputTokens: number): RateTier {
  const ordered = [...rate.tiers].sort((a, b) => {
    if (a.maxInputTokens === null) return 1;
    if (b.maxInputTokens === null) return -1;
    return a.maxInputTokens - b.maxInputTokens;
  });

  for (const tier of ordered) {
    if (tier.maxInputTokens === null || totalInputTokens <= tier.maxInputTokens) return tier;
  }
  // Difensivo: se nessuna fascia e' illimitata si usa la piu' alta.
  return ordered[ordered.length - 1]!;
}

export function tierLabel(rate: ModelRate, tier: RateTier): string {
  if (rate.tiers.length === 1) return 'default';
  return tier.maxInputTokens === null ? 'long-context' : 'default';
}

/**
 * Modelli la cui tariffa e' scaduta (tipicamente prezzi promozionali).
 * Da monitorare: oltre quella data il costo calcolato non e' piu' attendibile.
 */
export function expiredRates(asOf: Date = new Date()): ModelRate[] {
  return rateCard.models.filter((entry) => {
    if (!entry.validUntil) return false;
    const deadline = new Date(`${entry.validUntil}T23:59:59Z`);
    return !Number.isNaN(deadline.getTime()) && asOf > deadline;
  });
}
