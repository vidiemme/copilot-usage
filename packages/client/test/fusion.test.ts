import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { UsageEventPayload } from '@vidiemme/copilot-usage-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUsageRecord, readCliCalls } from '../src/reload/copilotCli.js';
import { readChatRequests } from '../src/reload/vscodeChat.js';
import { fusionFromCliUsage, fusionFromSelectedModel, isHydraFusionModel } from '../src/usage/fusion.js';
import { FusionCorrelator } from '../src/usage/fusionCorrelator.js';

function usageRecord(requestId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'session.usage_record',
    timestamp: '2026-11-03T10:00:00.000Z',
    data: {
      usage: {
        model: 'gpt-6.1-terra',
        inputTokens: 10,
        outputTokens: 2,
        serviceRequestId: requestId,
        ...extra,
      },
    },
  });
}

function start(selectedModel: string): string {
  return JSON.stringify({ type: 'session.start', data: { selectedModel } });
}

function event(requestId: string): UsageEventPayload {
  return {
    requestId,
    occurredAt: '2026-11-03T10:00:00.000Z',
    developerId: 'dev',
    developerSource: 'pseudonym',
    projectId: 'project',
    projectSource: 'workspace',
    repository: null,
    clientName: 'copilot/1.0',
    sessionId: null,
    endpoint: '/chat/completions',
    model: 'gpt-6.1-terra',
    hydraFusion: null,
    usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2 },
    streamed: true,
    durationMs: 20,
  };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 150 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
}

describe('rilevamento Fusion', () => {
  it('riconosce solo gli identificatori sintetici noti', () => {
    expect(isHydraFusionModel('copilot/HydraFusion')).toBe(true);
    expect(isHydraFusionModel('hydrafusion-max')).toBe(true);
    expect(isHydraFusionModel('gpt-6.1-terra')).toBe(false);
    expect(isHydraFusionModel('hydrafusion-like')).toBe(false);
    expect(fusionFromSelectedModel('copilot/claude-opus-5.5')).toBe(false);
    expect(fusionFromSelectedModel('copilot/auto')).toBeNull();
    expect(fusionFromSelectedModel('copilot/hydrafusion-high')).toBeNull();
    expect(fusionFromSelectedModel(undefined)).toBeNull();
  });

  it('usa il routing esplicito, non il modello fisico scelto dal router', () => {
    expect(fusionFromCliUsage({
      model: 'gpt-6.1-terra',
      fusion: { syntheticModel: 'hydrafusion' },
    }, 'gpt-6.1-terra')).toBe(true);
    expect(fusionFromCliUsage({ model: 'gpt-6.1-terra' }, 'gpt-6.1-terra')).toBe(false);
    expect(fusionFromCliUsage({ model: 'gpt-6.1-terra', isAuto: true }, 'gpt-6.1-terra')).toBeNull();
    expect(fusionFromCliUsage({ model: 'gpt-6.1-terra' }, 'hydrafusion')).toBeNull();
    expect(fusionFromCliUsage({ model: 'gpt-6.1-terra' }, 'claude-opus-5.5')).toBeNull();
    expect(fusionFromCliUsage({ model: 'gpt-6.1-terra', fusion: {} }, 'gpt-6.1-terra')).toBeNull();
    expect(fusionFromCliUsage({ model: 'gpt-6.1-terra', fusion: 'unexpected' }, 'gpt-6.1-terra')).toBeNull();
  });

  it('legge il flag nel record mantenendo il serviceRequestId', () => {
    const line = usageRecord('service-1', { fusion: { syntheticModel: 'hydrafusion' } });
    expect(parseUsageRecord(line, '/w', 'session')).toMatchObject({
      requestId: 'service-1',
      model: 'gpt-6.1-terra',
      hydraFusion: true,
    });
  });
});

describe('sessioni CLI', () => {
  let state: string;
  const correlators: FusionCorrelator[] = [];

  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'fusion-sessions-'));
  });

  afterEach(async () => {
    await Promise.all(correlators.splice(0).map((correlator) => correlator.close()));
    rmSync(state, { recursive: true, force: true });
  });

  function session(name: string, lines: string[]): string {
    const directory = join(state, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'workspace.yaml'), 'cwd: /work/project\n');
    const file = join(directory, 'events.jsonl');
    writeFileSync(file, lines.join('\n'));
    return file;
  }

  function correlator(delivered: UsageEventPayload[]): FusionCorrelator {
    const instance = new FusionCorrelator(state, (value) => delivered.push(value), { warn: vi.fn() }, 10, 1000);
    correlators.push(instance);
    return instance;
  }

  it('ricostruisce i cambi di modello e mantiene sconosciute le chiamate ambigue', () => {
    const change = JSON.stringify({ type: 'session.model_change', data: { newModel: 'gpt-6.1-terra' } });
    session('one', [
      start('hydrafusion'),
      usageRecord('fusion', { fusion: { syntheticModel: 'hydrafusion' } }),
      usageRecord('unknown'),
      change,
      usageRecord('direct'),
      usageRecord('other', { model: 'claude-opus-5.5' }),
      '',
    ]);

    expect(readCliCalls(state).map(({ requestId, hydraFusion }) => [requestId, hydraFusion])).toEqual([
      ['fusion', true],
      ['unknown', null],
      ['direct', false],
      ['other', null],
    ]);
  });

  it('nello storico della chat usa il modello scelto, non quello risolto', () => {
    const workspace = join(state, 'workspace');
    const storage = join(state, 'editor', 'window');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(storage, 'chatSessions'), { recursive: true });
    writeFileSync(join(storage, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(workspace).href }));
    const request = (requestId: string, modelId: string, resolvedModel = 'gpt-6.1-terra') => ({
      requestId,
      timestamp: Date.parse('2026-11-03T10:00:00Z'),
      modelId,
      result: { metadata: { resolvedModel } },
    });
    writeFileSync(join(storage, 'chatSessions', 'one.json'), JSON.stringify({
      sessionId: 'chat',
      requests: [
        request('fusion', 'copilot/hydrafusion'),
        request('direct', 'copilot/claude-opus-5.5'),
        request('direct-confirmed', 'copilot/claude-opus-5.5', 'claude-opus-5-5'),
        request('auto', 'copilot/auto'),
      ],
    }));

    expect(readChatRequests([{ editor: 'VS Code', path: join(state, 'editor') }])
      .map(({ requestId, model, hydraFusion }) => [requestId, model, hydraFusion])).toEqual([
      ['fusion', 'gpt-6.1-terra', true],
      ['direct', 'gpt-6.1-terra', null],
      ['direct-confirmed', 'claude-opus-5-5', false],
      ['auto', 'gpt-6.1-terra', null],
    ]);
  });

  it('aspetta il record completo e correla esattamente il serviceRequestId', async () => {
    const record = usageRecord('service-1', { fusion: { syntheticModel: 'hydrafusion' } });
    const file = session('one', [start('hydrafusion'), record.slice(0, 40)]);
    const delivered: UsageEventPayload[] = [];
    correlator(delivered).track(event('service-1'));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(delivered).toEqual([]);
    appendFileSync(file, `${record.slice(40)}\n`);
    await eventually(() => delivered.length === 1);
    expect(delivered[0]).toMatchObject({ requestId: 'service-1', hydraFusion: true, model: 'gpt-6.1-terra' });
  });

  it('privilegia il routing esplicito quando una sessione biforcata contiene lo stesso id', async () => {
    session('one', [start('gpt-6.1-terra'), usageRecord('same'), '']);
    session('two', [start('hydrafusion'), usageRecord('same', { fusion: { syntheticModel: 'hydrafusion' } }), '']);
    const delivered: UsageEventPayload[] = [];
    correlator(delivered).track(event('same'));

    await eventually(() => delivered.length === 1);
    expect(delivered[0]!.hydraFusion).toBe(true);
    expect(readCliCalls(state)[0]!.hydraFusion).toBe(true);
  });

  it('attende prove successive senza considerare non Fusion una chiamata sconosciuta', async () => {
    const file = session('one', [start('hydrafusion'), usageRecord('unknown'), '']);
    const delivered: UsageEventPayload[] = [];
    correlator(delivered).track(event('unknown'));

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(delivered).toEqual([]);
    appendFileSync(file, `${usageRecord('unknown', { fusion: { syntheticModel: 'hydrafusion' } })}\n`);
    await eventually(() => delivered.length === 1);
    expect(delivered[0]!.hydraFusion).toBe(true);
  });

  it('corregge un routing diretto quando arriva una prova esplicita Fusion', async () => {
    const file = session('one', [start('gpt-6.1-terra'), usageRecord('same'), '']);
    const delivered: UsageEventPayload[] = [];
    correlator(delivered).track(event('same'));

    await eventually(() => delivered.length === 1);
    expect(delivered[0]!.hydraFusion).toBe(false);
    appendFileSync(file, `${usageRecord('same', { fusion: { syntheticModel: 'hydrafusion' } })}\n`);
    await eventually(() => delivered.length === 2);
    expect(delivered[1]!.hydraFusion).toBe(true);
  });

  it('segnala un cambio modello malformato senza usare la selezione precedente', async () => {
    session('one', [
      start('gpt-6.1-terra'),
      '{"type":"session.model_change","data":',
      usageRecord('unknown'),
      '',
    ]);
    const delivered: UsageEventPayload[] = [];
    const warn = vi.fn();
    const instance = new FusionCorrelator(state, (value) => delivered.push(value), { warn }, 10, 1000);
    correlators.push(instance);
    instance.track(event('unknown'));

    await eventually(() => warn.mock.calls.length > 0);
    expect(warn).toHaveBeenCalledOnce();
    expect(delivered).toEqual([]);
  });

  it('trova Fusion in coda a log grandi senza dedurre il modello selezionato troncato', async () => {
    const large = JSON.stringify({ type: 'assistant.message', data: { content: 'x'.repeat(4 * 1024 * 1024) } });
    session('one', [
      start('gpt-6.1-terra'),
      large,
      usageRecord('fusion', { fusion: { syntheticModel: 'hydrafusion' } }),
      usageRecord('unknown'),
      '',
    ]);
    const delivered: UsageEventPayload[] = [];
    const instance = correlator(delivered);
    instance.track(event('fusion'));
    instance.track(event('unknown'));

    await eventually(() => delivered.length === 1);
    expect(delivered[0]).toMatchObject({ requestId: 'fusion', hydraFusion: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(delivered).toHaveLength(1);
  });

  it('legge solo le righe nuove conservando il modello selezionato fra le scansioni', async () => {
    const file = session('one', [start('gpt-6.1-terra'), '']);
    const delivered: UsageEventPayload[] = [];
    correlator(delivered).track(event('direct'));

    await new Promise((resolve) => setTimeout(resolve, 50));
    appendFileSync(file, `${usageRecord('direct')}\n`);
    await eventually(() => delivered.length === 1);
    expect(delivered[0]!.hydraFusion).toBe(false);
  });

  it('usa un record scritto prima che il proxy registri la richiesta', async () => {
    const file = session('one', [start('hydrafusion'), '']);
    const delivered: UsageEventPayload[] = [];
    const instance = correlator(delivered);
    instance.track(event('other'));
    appendFileSync(file, `${usageRecord('early', { fusion: { syntheticModel: 'hydrafusion' } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    instance.track(event('early'));
    await eventually(() => delivered.length === 1);
    expect(delivered[0]).toMatchObject({ requestId: 'early', hydraFusion: true });
  });

  it('dopo un salto oltre il limite di lettura non deduce la selezione diretta', async () => {
    const file = session('one', [start('gpt-6.1-terra'), '']);
    const delivered: UsageEventPayload[] = [];
    const instance = correlator(delivered);
    instance.track(event('other'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const large = JSON.stringify({ type: 'assistant.message', data: { content: 'x'.repeat(4 * 1024 * 1024) } });
    appendFileSync(file, `${large}\n${usageRecord('after-jump')}\n`);
    instance.track(event('after-jump'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(delivered).toEqual([]);
  });
});
