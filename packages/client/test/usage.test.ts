import { describe, expect, it } from 'vitest';
import { UsageCollector } from '../src/usage/collector.js';
import { parseAnthropicResponse } from '../src/usage/parseAnthropic.js';
import { parseOpenAIResponse, readOpenAIUsageBlock } from '../src/usage/parseOpenAI.js';

function sse(events: Array<{ event?: string; data: unknown }>): string {
  return events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`)
    .join('');
}

const encoder = new TextEncoder();

describe('stream Anthropic', () => {
  const stream = sse([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          model: 'claude-opus-4-5-20260101',
          usage: {
            input_tokens: 1200,
            cache_read_input_tokens: 30000,
            cache_creation_input_tokens: 5000,
            output_tokens: 1,
          },
        },
      },
    },
    { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { text: 'ciao' } } },
    { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 850 } } },
  ]);

  it('accumula input dal message_start e output dal message_delta', () => {
    const collector = new UsageCollector(true);
    collector.push(encoder.encode(stream));
    const usage = collector.finish();

    expect(usage).toEqual({
      model: 'claude-opus-4-5-20260101',
      inputTokens: 1200,
      cachedInputTokens: 30000,
      cacheWriteTokens: 5000,
      outputTokens: 850,
    });
  });

  it('funziona con chunk spezzati a meta di un evento', () => {
    const collector = new UsageCollector(true);
    const bytes = encoder.encode(stream);
    for (let i = 0; i < bytes.length; i += 7) collector.push(bytes.slice(i, i + 7));

    expect(collector.finish()?.outputTokens).toBe(850);
  });

  it('registra usage parziale se lo stream si interrompe', () => {
    const collector = new UsageCollector(true);
    collector.push(encoder.encode(stream.slice(0, stream.indexOf('content_block_delta'))));
    const usage = collector.finish();

    expect(usage?.inputTokens).toBe(1200);
    expect(usage?.outputTokens).toBe(1);
  });
});

describe('stream OpenAI / Copilot', () => {
  it('legge usage dal chunk finale e sottrae i cached dal prompt', () => {
    const collector = new UsageCollector(true);
    collector.push(
      encoder.encode(
        sse([
          { data: { model: 'gpt-5.4', choices: [{ delta: { content: 'x' } }] } },
          {
            data: {
              model: 'gpt-5.4',
              choices: [],
              usage: {
                prompt_tokens: 10000,
                completion_tokens: 500,
                prompt_tokens_details: { cached_tokens: 8000 },
              },
            },
          },
        ]) + 'data: [DONE]\n\n',
      ),
    );

    expect(collector.finish()).toEqual({
      model: 'gpt-5.4',
      inputTokens: 2000,
      cachedInputTokens: 8000,
      cacheWriteTokens: 0,
      outputTokens: 500,
    });
  });

  it('non conta due volte i token in cache', () => {
    const usage = readOpenAIUsageBlock({
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 1000 },
    });

    expect(usage?.inputTokens).toBe(0);
    expect(usage?.cachedInputTokens).toBe(1000);
  });
});

describe('risposte non streaming', () => {
  it('legge il corpo JSON Anthropic', () => {
    const collector = new UsageCollector(false);
    collector.push(
      encoder.encode(
        JSON.stringify({
          model: 'claude-sonnet-4.5',
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
        }),
      ),
    );

    expect(collector.finish()).toMatchObject({ inputTokens: 100, outputTokens: 20 });
  });

  it('ignora corpi senza usage', () => {
    const collector = new UsageCollector(false);
    collector.push(encoder.encode(JSON.stringify({ data: [{ id: 'gpt-5.4' }] })));
    expect(collector.finish()).toBeUndefined();
  });

  it('parser diretti', () => {
    expect(parseAnthropicResponse({ usage: { input_tokens: 1 } })?.inputTokens).toBe(1);
    expect(parseOpenAIResponse({ usage: { prompt_tokens: 3 } })?.inputTokens).toBe(3);
  });
});
