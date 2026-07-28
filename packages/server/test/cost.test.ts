import { describe, expect, it } from 'vitest';
import { computeCost } from '../src/pricing/cost.js';
import { expiredRates, normalizeModelId, findModelRate, rateCard } from '../src/pricing/rateCard.js';

describe('normalizzazione id modello', () => {
  it.each([
    ['claude-opus-4.5', 'claude-opus-4-5'],
    ['claude-opus-4-5-20260101', 'claude-opus-4-5'],
    ['anthropic/claude-sonnet-4.6', 'claude-sonnet-4-6'],
    ['GPT-5.4 mini', 'gpt-5-4-mini'],
    ['gemini-3.1-pro-preview', 'gemini-3-1-pro'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeModelId(input)).toBe(expected);
  });

  it('non confonde gpt-5-mini con gpt-5.4-mini', () => {
    expect(findModelRate('gpt-5-mini')?.model).toBe('GPT-5 mini');
    expect(findModelRate('gpt-5.4-mini')?.model).toBe('GPT-5.4 mini');
  });
});

describe('calcolo costo', () => {
  it('applica le quattro tariffe Anthropic', () => {
    const cost = computeCost('claude-opus-4.5', {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    // 5.00 + 0.50 + 6.25 + 25.00
    expect(cost.costUsd).toBeCloseTo(36.75, 6);
    expect(cost.aiCredits).toBeCloseTo(3675, 3);
    expect(cost.priced).toBe(true);
  });

  it('passa alla fascia long context oltre la soglia', () => {
    const short = computeCost('gpt-5.4', {
      inputTokens: 200_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });
    const long = computeCost('gpt-5.4', {
      inputTokens: 300_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });

    expect(short.tier).toBe('default');
    expect(short.costUsd).toBeCloseTo(0.5, 6);
    expect(long.tier).toBe('long-context');
    expect(long.costUsd).toBeCloseTo(1.5, 6);
  });

  it('la soglia considera anche i token letti da cache', () => {
    const cost = computeCost('gpt-5.4', {
      inputTokens: 100_000,
      cachedInputTokens: 200_000,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });

    expect(cost.tier).toBe('long-context');
  });

  it('marca come non tariffato un modello sconosciuto', () => {
    const cost = computeCost('modello-inventato', {
      inputTokens: 1000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1000,
    });

    expect(cost.priced).toBe(false);
    expect(cost.costUsd).toBe(0);
    expect(cost.canonicalModel).toBeNull();
  });
});

describe('integrita del listino', () => {
  it('ogni modello ha almeno una fascia con tariffe non negative', () => {
    for (const entry of rateCard.models) {
      expect(entry.tiers.length, entry.model).toBeGreaterThan(0);
      for (const tier of entry.tiers) {
        expect(tier.input, entry.model).toBeGreaterThanOrEqual(0);
        expect(tier.cachedInput, entry.model).toBeGreaterThanOrEqual(0);
        expect(tier.cacheWrite, entry.model).toBeGreaterThanOrEqual(0);
        expect(tier.output, entry.model).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('i modelli a piu fasce hanno una fascia illimitata', () => {
    for (const entry of rateCard.models) {
      if (entry.tiers.length < 2) continue;
      expect(
        entry.tiers.some((tier) => tier.maxInputTokens === null),
        entry.model,
      ).toBe(true);
    }
  });

  it('segnala le tariffe scadute', () => {
    expect(expiredRates(new Date('2026-07-25T00:00:00Z'))).toHaveLength(0);
    expect(expiredRates(new Date('2026-09-01T00:00:00Z')).map((e) => e.key)).toEqual([
      'claude-sonnet-5',
    ]);
  });
});
