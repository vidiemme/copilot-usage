import { describe, expect, it } from 'vitest';
import { UsageCollector } from '../src/usage/collector.js';
import { findCopilotUsage, readCopilotUsage } from '../src/usage/copilotUsage.js';

const encoder = new TextEncoder();

function sse(payloads: unknown[]): Uint8Array {
  return encoder.encode(payloads.map((data) => `data: ${JSON.stringify(data)}\n\n`).join(''));
}

function details(model: string, counts: { input: number; cache_read: number; cache_write: number; output: number }) {
  return Object.entries(counts).map(([token_type, token_count]) => ({
    batch_size: 1_000_000,
    cost_per_batch: 1,
    model,
    token_count,
    token_type,
  }));
}

// Forme catturate da api.githubcopilot.com: `copilot_usage` sta sempre al
// primo livello del payload, accanto a `usage`.
describe('copilot_usage', () => {
  it("legge addebito, contatori e modello", () => {
    const billing = readCopilotUsage({
      token_details: details('claude-haiku-5.5', { input: 4, cache_read: 0, cache_write: 28895, output: 4 }),
      total_nano_aiu: 361_427_500,
    });

    expect(billing).toEqual({
      totalNanoAiu: 361_427_500,
      model: 'claude-haiku-5.5',
      tokens: { inputTokens: 4, cachedInputTokens: 0, cacheWriteTokens: 28895, outputTokens: 4 },
    });
  });

  it("ignora blocchi senza importo valido", () => {
    expect(readCopilotUsage({ token_details: [] })).toBeUndefined();
    expect(readCopilotUsage({ total_nano_aiu: -5 })).toBeUndefined();
    expect(readCopilotUsage(null)).toBeUndefined();
    expect(findCopilotUsage({ usage: {} })).toBeUndefined();
  });

  it("tiene l'importo anche senza token_details", () => {
    expect(readCopilotUsage({ total_nano_aiu: 870_000 })).toEqual({ totalNanoAiu: 870_000 });
  });

  // L'usage standard di /chat/completions per Claude non distingue le
  // scritture in cache: senza token_details sarebbero prezzate come input.
  it('chat completions Claude: le scritture in cache arrivano solo da token_details', () => {
    const collector = new UsageCollector(true);
    collector.push(
      sse([
        { choices: [{ delta: { content: 'ciao' } }], model: 'claude-haiku-5.5' },
        {
          choices: [{ finish_reason: 'stop', delta: { content: null } }],
          model: 'claude-haiku-5.5',
          usage: { completion_tokens: 285, prompt_tokens: 23632, prompt_tokens_details: { cached_tokens: 13900 } },
          copilot_usage: {
            token_details: details('claude-haiku-5.5', { input: 4, cache_read: 13900, cache_write: 9728, output: 285 }),
            total_nano_aiu: 149_790_000,
          },
        },
      ]),
    );
    collector.push(encoder.encode('data: [DONE]\n\n'));

    expect(collector.finish()).toEqual({
      model: 'claude-haiku-5.5',
      inputTokens: 4,
      cachedInputTokens: 13900,
      cacheWriteTokens: 9728,
      outputTokens: 285,
      billedNanoAiu: 149_790_000,
    });
  });

  it('stream Anthropic: copilot_usage nel message_delta', () => {
    const collector = new UsageCollector(true);
    collector.push(
      sse([
        {
          type: 'message_start',
          message: {
            model: 'claude-haiku-5-5',
            usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3 },
          },
        },
        {
          type: 'message_delta',
          usage: { input_tokens: 10, output_tokens: 8 },
          copilot_usage: {
            token_details: details('claude-haiku-5.5', { input: 10, cache_read: 0, cache_write: 0, output: 8 }),
            total_nano_aiu: 500_000,
          },
        },
      ]),
    );

    expect(collector.finish()).toMatchObject({
      model: 'claude-haiku-5-5',
      inputTokens: 10,
      outputTokens: 8,
      billedNanoAiu: 500_000,
    });
  });

  it("stream Responses API: copilot_usage sull'evento, fuori da response", () => {
    const collector = new UsageCollector(true);
    collector.push(
      sse([
        { type: 'response.created', response: { model: 'gpt-6-luna', usage: null } },
        {
          type: 'response.incomplete',
          copilot_usage: {
            token_details: details('gpt-6-luna', { input: 7, cache_read: 0, cache_write: 0, output: 16 }),
            total_nano_aiu: 870_000,
          },
          response: {
            model: 'gpt-6-luna',
            usage: {
              input_tokens: 7,
              input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
              output_tokens: 16,
            },
          },
        },
      ]),
    );

    expect(collector.finish()).toMatchObject({ model: 'gpt-6-luna', inputTokens: 7, outputTokens: 16, billedNanoAiu: 870_000 });
  });

  it('risposta non streaming: copilot_usage alla radice', () => {
    const collector = new UsageCollector(false);
    collector.push(
      encoder.encode(
        JSON.stringify({
          model: 'gemini-3.8-flash',
          usage: { completion_tokens: 9, prompt_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
          copilot_usage: {
            token_details: details('gemini-3.8-flash', { input: 1, cache_read: 0, cache_write: 0, output: 9 }),
            total_nano_aiu: 3_450_000,
          },
        }),
      ),
    );

    expect(collector.finish()).toMatchObject({ inputTokens: 1, outputTokens: 9, billedNanoAiu: 3_450_000 });
  });

  it('senza copilot_usage il risultato non cambia', () => {
    const collector = new UsageCollector(false);
    collector.push(encoder.encode(JSON.stringify({ model: 'gpt-5.4', usage: { prompt_tokens: 10, completion_tokens: 2 } })));

    expect(collector.finish()).toEqual({
      model: 'gpt-5.4',
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 2,
    });
  });

  // Responses API non streaming: `input_tokens` include i cached (convenzione OpenAI).
  it('risposta Responses non streaming: sottrae i cached anche senza copilot_usage', () => {
    const collector = new UsageCollector(false);
    collector.push(
      encoder.encode(
        JSON.stringify({
          object: 'response',
          model: 'gpt-6-luna',
          usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 5 },
        }),
      ),
    );

    expect(collector.finish()).toMatchObject({ inputTokens: 200, cachedInputTokens: 800, outputTokens: 5 });
  });
});
