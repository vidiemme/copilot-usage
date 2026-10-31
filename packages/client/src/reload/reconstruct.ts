import type { TokenCounters } from '@vidiemme/copilot-usage-contract';

/** Prezzi in USD per 1M token, nella forma restituita da `GET /v1/rates`. */
export interface RateTier {
  maxInputTokens: number | null;
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export interface BilledRequest {
  /** Round del modello dentro la richiesta: ognuno e' una chiamata upstream. */
  rounds: number;
  /** Dimensione del contesto all'ultimo round. */
  promptTokens: number;
  /** Output di tutti i round, ragionamento compreso. */
  completionTokens: number;
  /** Crediti addebitati per l'intera richiesta. */
  credits: number;
}

const TOKENS_PER_UNIT = 1_000_000;

/** Stessa scelta di fascia del collector: per totale di input della singola chiamata. */
export function selectTier(tiers: RateTier[], inputTokens: number): RateTier | undefined {
  const ordered = [...tiers].sort((a, b) => {
    if (a.maxInputTokens === null) return 1;
    if (b.maxInputTokens === null) return -1;
    return a.maxInputTokens - b.maxInputTokens;
  });
  return (
    ordered.find((tier) => tier.maxInputTokens === null || inputTokens <= tier.maxInputTokens) ??
    ordered[ordered.length - 1]
  );
}

interface InputSplit {
  total: number;
  /** Token della fascia cara: scrittura in cache, o input fresco se costa di piu'. */
  expensive: number;
}

/**
 * Divide il budget di input fra letture dalla cache e token a prezzo pieno.
 *
 * Si assume che ogni round rilegga un contesto vicino a quello finale: e' cio'
 * che accade in una sessione agentica, dove storia e risultati degli strumenti
 * dominano il prompt. Quanto il budget eccede quelle letture e' contesto nuovo,
 * pagato alla tariffa piena. Se il budget non basta nemmeno per le letture, il
 * contesto riletto era piu' corto e si riduce di conseguenza.
 */
function splitInput(budgetUsd: number, estimatedTotal: number, cheap: number, expensive: number): InputSplit {
  if (budgetUsd <= 0) return { total: 0, expensive: 0 };
  if (cheap <= 0 && expensive <= 0) return { total: estimatedTotal, expensive: 0 };

  const units = budgetUsd * TOKENS_PER_UNIT;
  if (cheap * estimatedTotal >= units) {
    return { total: cheap > 0 ? Math.round(units / cheap) : estimatedTotal, expensive: 0 };
  }
  if (expensive <= cheap) return { total: estimatedTotal, expensive: 0 };

  const premium = (units - cheap * estimatedTotal) / (expensive - cheap);
  if (premium <= estimatedTotal) return { total: estimatedTotal, expensive: Math.round(premium) };
  // Neanche un contesto tutto a prezzo pieno spiega l'addebito: era piu' lungo.
  const total = Math.round(units / expensive);
  return { total, expensive: total };
}

function share(total: number, parts: number, index: number): number {
  const base = Math.floor(total / parts);
  return index === parts - 1 ? total - base * (parts - 1) : base;
}

/**
 * Ricostruisce i contatori dei singoli round di una richiesta di Copilot Chat.
 *
 * VS Code conserva per ogni richiesta i crediti addebitati, l'output totale e
 * il contesto dell'ultimo round, ma non quanto ciascun round abbia letto dalla
 * cache o scritto. La ripartizione si ricostruisce quindi in modo che, prezzata
 * con il listino del collector, dia esattamente l'addebito: i token sono una
 * stima, il costo no.
 *
 * Si producono contatori per round, non uno per richiesta, perche' la fascia
 * tariffaria dipende dall'input della singola chiamata: sommare decine di round
 * in un evento lo spingerebbe nella fascia long context.
 */
export function reconstructRounds(
  request: BilledRequest,
  tiers: RateTier[],
  creditUsd: number,
): TokenCounters[] | undefined {
  const rounds = Math.max(1, Math.floor(request.rounds));
  const prompt = Math.max(0, request.promptTokens);
  const output = Math.max(0, request.completionTokens);
  const budgetUsd = request.credits * creditUsd;

  let tier = selectTier(tiers, prompt);
  if (!tier) return undefined;

  let split: InputSplit = { total: 0, expensive: 0 };
  // Una seconda passata basta: la fascia cambia solo se la stima del contesto si sposta.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const premiumRate = Math.max(tier.cacheWrite, tier.input);
    const inputBudget = budgetUsd - (output * tier.output) / TOKENS_PER_UNIT;
    split = splitInput(inputBudget, rounds * prompt, tier.cachedInput, premiumRate);

    const next = selectTier(tiers, Math.ceil(split.total / rounds));
    if (!next || next === tier) break;
    tier = next;
  }

  const premiumIsWrite = tier.cacheWrite >= tier.input;
  return Array.from({ length: rounds }, (_, index) => {
    const total = share(split.total, rounds, index);
    const expensive = Math.min(total, share(split.expensive, rounds, index));
    return {
      inputTokens: premiumIsWrite ? 0 : expensive,
      cachedInputTokens: total - expensive,
      cacheWriteTokens: premiumIsWrite ? expensive : 0,
      outputTokens: share(output, rounds, index),
    };
  });
}
