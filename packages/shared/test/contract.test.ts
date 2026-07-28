import { describe, expect, it } from 'vitest';
import {
  InvalidEventError,
  MAX_EVENTS_PER_BATCH,
  parseIngestBody,
  parseUsageEvent,
  totalInputTokens,
} from '@vidiemme/copilot-usage-contract';

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-1',
    occurredAt: '2026-02-01T10:00:00.000Z',
    developerId: 'dev-abc',
    developerSource: 'pseudonym',
    projectId: 'acme/web/portal',
    projectSource: 'workspace',
    repository: {
      projectId: 'acme/web/portal',
      host: 'gitlab.com',
      groups: ['acme', 'web'],
      name: 'portal',
      remoteUrl: 'git@gitlab.com:acme/web/portal.git',
    },
    clientName: 'GitHubCopilotChat/0.57.0',
    sessionId: 'sess-1',
    endpoint: '/chat/completions',
    model: 'gpt-5.4',
    usage: {
      inputTokens: 1000,
      cachedInputTokens: 200,
      cacheWriteTokens: 0,
      outputTokens: 300,
    },
    streamed: true,
    durationMs: 1234,
    ...overrides,
  };
}

describe('parseUsageEvent', () => {
  it('normalizza un evento completo', () => {
    const event = parseUsageEvent(validEvent());

    expect(event.projectId).toBe('acme/web/portal');
    expect(event.repository?.groups).toEqual(['acme', 'web']);
    expect(event.usage.inputTokens).toBe(1000);
    expect(totalInputTokens(event.usage)).toBe(1200);
  });

  it('accetta un evento senza repository, modello e sessione', () => {
    const event = parseUsageEvent(
      validEvent({ repository: null, model: null, sessionId: null, durationMs: null }),
    );

    expect(event.repository).toBeNull();
    expect(event.model).toBeNull();
    expect(event.durationMs).toBeNull();
  });

  it('rifiuta gli eventi senza chiave di deduplica', () => {
    expect(() => parseUsageEvent(validEvent({ requestId: '' }))).toThrow(InvalidEventError);
  });

  it('rifiuta una data non interpretabile', () => {
    expect(() => parseUsageEvent(validEvent({ occurredAt: 'ieri' }))).toThrow(InvalidEventError);
  });

  it('normalizza la data in UTC', () => {
    const event = parseUsageEvent(validEvent({ occurredAt: '2026-02-01T12:00:00+02:00' }));

    expect(event.occurredAt).toBe('2026-02-01T10:00:00.000Z');
  });

  it('rifiuta contatori negativi, non numerici o assurdi', () => {
    for (const usage of [
      { inputTokens: -1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      { inputTokens: '100', cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      { inputTokens: Number.NaN, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      { inputTokens: 2_000_000_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    ]) {
      expect(() => parseUsageEvent(validEvent({ usage }))).toThrow(InvalidEventError);
    }
  });

  it('rifiuta un evento privo di contatori', () => {
    expect(() => parseUsageEvent(validEvent({ usage: undefined }))).toThrow(InvalidEventError);
  });

  // I campi descrittivi arrivano dal client: si troncano invece di rifiutare,
  // altrimenti uno user-agent anomalo farebbe perdere la misura.
  it('tronca i campi descrittivi troppo lunghi', () => {
    const event = parseUsageEvent(
      validEvent({ clientName: 'x'.repeat(5000), endpoint: `/${'y'.repeat(5000)}` }),
    );

    expect(event.clientName).toHaveLength(200);
    expect(event.endpoint).toHaveLength(500);
  });

  it('scarta i gruppi non testuali e limita la profondita', () => {
    const event = parseUsageEvent(
      validEvent({
        repository: {
          projectId: 'acme/portal',
          host: null,
          groups: [...Array.from({ length: 50 }, (_, i) => `g${i}`), 42, null],
          name: 'portal',
          remoteUrl: null,
        },
      }),
    );

    expect(event.repository?.groups).toHaveLength(20);
    expect(event.repository?.groups.every((g) => typeof g === 'string')).toBe(true);
  });
});

describe('parseIngestBody', () => {
  it('rifiuta un corpo non conforme', () => {
    expect(() => parseIngestBody(null)).toThrow(InvalidEventError);
    expect(() => parseIngestBody({ events: {} })).toThrow(InvalidEventError);
    expect(() => parseIngestBody({ events: [] })).toThrow(InvalidEventError);
  });

  it('rifiuta i batch oltre il limite', () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) =>
      validEvent({ requestId: `req-${i}` }),
    );

    expect(() => parseIngestBody({ events })).toThrow(/troppi eventi/);
  });

  it('accetta un batch al limite', () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH }, (_, i) =>
      validEvent({ requestId: `req-${i}` }),
    );

    expect(parseIngestBody({ events }).events).toHaveLength(MAX_EVENTS_PER_BATCH);
  });
});
