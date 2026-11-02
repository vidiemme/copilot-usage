import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyLiteLLMRouting,
  configFromCommand,
  copilotModelMatcher,
  readCopilotRoutes,
} from '../src/litellm.js';
import { readClaudeCalls, readClineTask, readOpencodeCalls, type AgentCall } from '../src/reload/agents.js';
import { buildReloadPlan } from '../src/reload/index.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agents-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

describe('Claude Code', () => {
  const line = (id: string, output: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-10T08:00:00Z',
      cwd: '/work/portale',
      sessionId: 's1',
      requestedModel: 'claude-opus-5-5',
      message: {
        id,
        model: 'claude-opus-5.5',
        usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: output },
      },
      ...extra,
    });

  it('tiene una chiamata per messaggio, con i contatori finali, anche dai subagent', () => {
    const project = join(dir, 'projects', '-work-portale');
    write(join(project, 's1.jsonl'), [line('msg_1', 1), line('msg_1', 40), '{"type":"user"}', line('msg_1', 40)].join('\n'));
    write(join(project, 's1', 'subagents', 'agent-a.jsonl'), line('msg_2', 5));
    write(
      join(project, 's2.jsonl'),
      [
        JSON.stringify({ type: 'assistant', timestamp: '2026-09-10T08:00:00Z', message: { id: 'x', model: '<synthetic>', usage: {} } }),
        line('msg_3', 5, { isApiErrorMessage: true }),
      ].join('\n'),
    );

    const calls = readClaudeCalls(join(dir, 'projects')).sort((a, b) => a.requestId.localeCompare(b.requestId));

    expect(calls.map((call) => call.requestId)).toEqual(['claude-code:msg_1', 'claude-code:msg_2']);
    expect(calls[0]).toMatchObject({
      cwd: '/work/portale',
      models: ['claude-opus-5-5', 'claude-opus-5.5'],
      usage: { inputTokens: 10, cachedInputTokens: 900, cacheWriteTokens: 90, outputTokens: 40 },
    });
  });
});

describe('Cline', () => {
  it('toglie la cache dall\'input dei provider in stile OpenAI e ricava cartella e modello', () => {
    const task = join(dir, 'tasks', '1790000000000');
    const started = (ts: number, info: Record<string, unknown>) => ({ ts, type: 'say', say: 'api_req_started', text: JSON.stringify(info) });
    write(
      join(task, 'ui_messages.json'),
      JSON.stringify([
        { ts: 1, type: 'say', say: 'text', text: 'ciao' },
        started(1_790_000_001_000, {
          request: '<environment_details>\n# Current Working Directory (/work/portale) Files\n</environment_details>',
          tokensIn: 1000,
          tokensOut: 50,
          cacheReads: 800,
          cacheWrites: 100,
        }),
        started(1_790_000_002_000, { tokensIn: 30, tokensOut: 5, cacheReads: 900, cacheWrites: 0 }),
        started(1_790_000_003_000, { request: 'annullata' }),
      ]),
    );
    write(
      join(task, 'task_metadata.json'),
      JSON.stringify({
        model_usage: [
          { ts: 1_790_000_000_500, model_id: 'claude-opus-5-5', model_provider_id: 'litellm' },
          { ts: 1_790_000_001_500, model_id: 'claude-opus-5-5', model_provider_id: 'anthropic' },
        ],
      }),
    );

    const calls = readClineTask(task);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      requestId: 'cline:1790000000000:1790000001000',
      cwd: '/work/portale',
      models: ['claude-opus-5-5'],
      provider: 'litellm',
      usage: { inputTokens: 100, cachedInputTokens: 800, cacheWriteTokens: 100, outputTokens: 50 },
    });
    // Col provider Anthropic `tokensIn` esclude gia' la cache.
    expect(calls[1]).toMatchObject({ provider: 'anthropic', usage: { inputTokens: 30, cachedInputTokens: 900 } });
  });
});

describe('opencode', () => {
  const message = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    role: 'assistant',
    modelID: 'claude-opus-5.5',
    providerID: 'github-copilot',
    time: { created: 1_790_000_000_000, completed: 1_790_000_004_000 },
    tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 900, write: 0 } },
    ...extra,
  });

  it('legge sia i JSON delle versioni precedenti sia opencode.db, senza doppioni', () => {
    const storage = join(dir, 'opencode', 'storage');
    write(join(storage, 'session', 'p1', 'ses_1.json'), JSON.stringify({ id: 'ses_1', directory: '/work/portale' }));
    write(join(storage, 'message', 'ses_1', 'msg_1.json'), JSON.stringify(message('msg_1')));
    write(join(storage, 'message', 'ses_1', 'msg_u.json'), JSON.stringify({ id: 'msg_u', role: 'user' }));

    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(join(dir, 'opencode', 'opencode.db'));
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);`);
    db.prepare('INSERT INTO session VALUES (?, ?)').run('ses_2', '/work/api');
    const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
    insert.run('msg_1', 'ses_1', 1_790_000_000_000, JSON.stringify(message('msg_1')));
    const { id: _id, ...withoutId } = message('msg_2', { providerID: 'litellm' });
    insert.run('msg_2', 'ses_2', 1_790_000_000_000, JSON.stringify(withoutId));
    db.close();

    const calls = readOpencodeCalls(join(dir, 'opencode')).sort((a, b) => a.requestId.localeCompare(b.requestId));

    expect(calls.map((call) => [call.requestId, call.cwd, call.provider])).toEqual([
      ['opencode:msg_1', '/work/portale', 'github-copilot'],
      ['opencode:msg_2', '/work/api', 'litellm'],
    ]);
    expect(calls[0]).toMatchObject({
      usage: { inputTokens: 10, cachedInputTokens: 900, cacheWriteTokens: 0, outputTokens: 25 },
      durationMs: 4000,
    });
  });
});

const CONFIG = `# config di prova
model_list:
  - model_name: claude-opus-5-5 # alias usato da Claude Code
    litellm_params:
      model: github_copilot/claude-opus-5.5
  - model_name: gpt-6-1-sol
    litellm_params:
      model: github_copilot/gpt-6.1-sol
      api_base: https://api.githubcopilot.com
  - model_name: copilot/*
    litellm_params:
      model: github_copilot/*
  - model_name: enterprise
    litellm_params:
      model: github_copilot/gpt-6-luna
      api_base: https://gateway.example.com
  - model_name: sonnet-diretto
    litellm_params:
      model: anthropic/claude-sonnet-5.5
`;

describe('LiteLLM', () => {
  it('indirizza al proxy le sole rotte Copilot, conservando i commenti', () => {
    const file = join(dir, 'config.yaml');
    writeFileSync(file, CONFIG);

    const result = applyLiteLLMRouting(file, 8787);
    const updated = readFileSync(file, 'utf-8');

    expect(result.updated).toBe(3);
    expect(result.foreign.map((route) => route.alias)).toEqual(['enterprise']);
    expect(readFileSync(`${file}.bak`, 'utf-8')).toBe(CONFIG);
    expect(updated).toContain('# alias usato da Claude Code');
    expect(readCopilotRoutes(file)!.map((route) => [route.alias, route.apiBase])).toEqual([
      ['claude-opus-5-5', 'http://127.0.0.1:8787'],
      ['gpt-6-1-sol', 'http://127.0.0.1:8787'],
      ['copilot/*', 'http://127.0.0.1:8787'],
      ['enterprise', 'https://gateway.example.com'],
    ]);
    expect(updated).not.toMatch(/sonnet-diretto[\s\S]*api_base/);

    // Rilanciare non riscrive nulla.
    expect(applyLiteLLMRouting(file, 8787)).toMatchObject({ updated: 0, already: 3 });
  });

  it('trova il file di configurazione nella riga di comando', () => {
    expect(configFromCommand('/opt/homebrew/bin/python3 /Users/x/.venv/bin/litellm --config /Users/x/litellm.yaml --port 4000')).toBe('/Users/x/litellm.yaml');
    expect(configFromCommand('python -m litellm -c "/Users/x/my config.yaml"')).toBe('/Users/x/my config.yaml');
    expect(configFromCommand('litellm --config=conf.yaml')).toBe('conf.yaml');
    expect(configFromCommand('node server.js --config other.yaml')).toBeUndefined();
  });

  it('riconosce il modello Copilot da alias, jolly o nome restituito', () => {
    const file = join(dir, 'config.yaml');
    writeFileSync(file, CONFIG);
    const match = copilotModelMatcher(readCopilotRoutes(file)!);

    expect(match(['claude-opus-5-5'])).toBe('github_copilot/claude-opus-5.5');
    expect(match(['altro', 'gpt-6.1-sol'])).toBe('github_copilot/gpt-6.1-sol');
    expect(match(['copilot/gemini-4-argon'])).toBe('github_copilot/gemini-4-argon');
    expect(match(['sonnet-diretto', 'claude-sonnet-5.5'])).toBeUndefined();
  });
});

describe('piano degli harness', () => {
  const call = (id: string, overrides: Partial<AgentCall> = {}): AgentCall => ({
    tool: 'claude-code',
    requestId: `claude-code:${id}`,
    occurredAt: new Date('2026-09-10T08:00:00Z'),
    cwd: join(dir, 'portale'),
    sessionId: 's1',
    models: ['claude-opus-5-5'],
    provider: null,
    usage: { inputTokens: 10, cachedInputTokens: 900, cacheWriteTokens: 0, outputTokens: 20 },
    durationMs: null,
    ...overrides,
  });

  function plan(agents: Parameters<typeof buildReloadPlan>[1]['agents'], calls: AgentCall[]) {
    mkdirSync(join(dir, 'portale', '.git'), { recursive: true });
    return buildReloadPlan(
      { cliCalls: [], chatRequests: [], agentCalls: calls },
      { roots: [dir], markers: ['.git'], agents },
      'dev-1',
      undefined,
    );
  }

  const matcher = (models: string[]) => (models.includes('claude-opus-5-5') ? 'github_copilot/claude-opus-5.5' : undefined);

  it('carica solo le chiamate passate da Copilot, col modello Copilot, fino a quando misura il proxy', () => {
    const result = plan({ matcher, measuredSince: new Date('2026-10-01T00:00:00Z') }, [
      call('a'),
      call('b', { models: ['claude-sonnet-5-5'] }),
      call('c', { occurredAt: new Date('2026-10-02T00:00:00Z') }),
      call('d', { tool: 'opencode', requestId: 'opencode:d', models: ['gpt-6-luna'], provider: 'github-copilot' }),
    ]);

    expect(result.events.map((event) => [event.requestId, event.model, event.clientName])).toEqual([
      ['claude-code:a', 'github_copilot/claude-opus-5.5', 'claude-code/reload'],
      ['opencode:d', 'gpt-6-luna', 'opencode/reload'],
    ]);
    expect(result.skippedAgents.notRouted).toEqual(new Map([['claude-code claude-sonnet-5-5', 1]]));
    expect(result.skippedAgents.measured).toBe(1);
    expect(result.sources).toMatchObject({ 'claude-code': 1, opencode: 1 });
  });

  it('senza config di LiteLLM esclude tutto, salvo con --agents-all', () => {
    expect(plan(undefined, [call('a')]).events).toHaveLength(0);
    expect(plan({ all: true }, [call('a')]).events.map((event) => event.model)).toEqual(['claude-opus-5-5']);
  });
});
