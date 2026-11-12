import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDetector } from '../src/projectDetector.js';

let root: string;

function makeRepo(segments: string[], remoteUrl: string): void {
  const gitDir = join(root, ...segments, '.git');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'config'), `[remote "origin"]\n\turl = ${remoteUrl}\n`);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'proxy-projects-'));
  // Cartelle locali dal nome arbitrario: l'identita' deve venire dal remote.
  makeRepo(['acme', 'cartella-a-caso'], 'git@gitlab.com:acme/web/portal.git');
  makeRepo(['crm-locale'], 'https://github.com/acme/legacy-crm.git');
  makeRepo(['Progetto Cliente'], 'git@gitlab.com:cliente/app.git');
  mkdirSync(join(root, 'scratch', 'notes'), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function detector(stickyTtlMs = 60_000): ProjectDetector {
  return new ProjectDetector({
    roots: [root],
    markers: ['.git'],
    stickyTtlMs,
    maxScanBytes: 4 * 1024 * 1024,
  });
}

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf-8');
}

describe('ProjectDetector', () => {
  it('risale dal file citato al progetto dichiarato dal remote', () => {
    const request = body({
      messages: [{ role: 'user', content: `Sistema ${root}/acme/cartella-a-caso/src/index.ts` }],
    });

    const detected = detector().detect(request, 's:1');
    expect(detected?.source).toBe('workspace');
    expect(detected?.repository).toMatchObject({
      projectId: 'acme/web/portal',
      groups: ['acme', 'web'],
      name: 'portal',
      host: 'gitlab.com',
    });
  });

  it('sceglie il progetto piu citato quando la richiesta ne nomina piu di uno', () => {
    const request = body({
      messages: [
        { role: 'user', content: `${root}/crm-locale/README.md` },
        {
          role: 'assistant',
          content: `${root}/acme/cartella-a-caso/src/a.ts ${root}/acme/cartella-a-caso/src/b.ts`,
        },
      ],
    });

    expect(detector().detect(request, 's:1')?.repository.projectId).toBe('acme/web/portal');
  });

  it('eredita il progetto sulle richieste che non citano file', () => {
    const instance = detector();
    instance.detect(body({ text: `${root}/crm-locale/src/app.ts` }), 's:window-1');

    const inherited = instance.detect(body({ text: 'genera un titolo' }), 's:window-1');
    expect(inherited?.source).toBe('session');
    expect(inherited?.repository.projectId).toBe('acme/legacy-crm');
  });

  it('tiene separate due finestre aperte in parallelo', () => {
    const instance = detector();
    instance.detect(body({ text: `${root}/acme/cartella-a-caso/src/a.ts` }), 's:window-1');
    instance.detect(body({ text: `${root}/crm-locale/src/b.ts` }), 's:window-2');

    expect(instance.detect(body({ text: 'domanda secca' }), 's:window-1')?.repository.projectId).toBe(
      'acme/web/portal',
    );
    expect(instance.detect(body({ text: 'domanda secca' }), 's:window-2')?.repository.projectId).toBe(
      'acme/legacy-crm',
    );
  });

  it('dimentica il progetto quando la sessione scade', () => {
    const instance = detector(1_000);
    const start = 1_000_000;
    instance.detect(body({ text: `${root}/crm-locale/src/app.ts` }), 's:window-1', start);

    expect(instance.detect(body({ text: 'ciao' }), 's:window-1', start + 500)).toBeDefined();
    expect(instance.detect(body({ text: 'ciao' }), 's:window-1', start + 2_000)).toBeUndefined();
  });

  it('riconosce le cartelle con spazi nel nome', () => {
    const request = body({ text: `Guarda ${root}/Progetto Cliente/src/main.ts e sistemalo` });

    expect(detector().detect(request, 's:1')?.repository.projectId).toBe('cliente/app');
  });

  it('riconosce i path dentro URI file:// percent-encoded', () => {
    const uri = `file://${root}/Progetto Cliente/src/main.ts`.replace(/ /g, '%20');

    expect(detector().detect(body({ uri }), 's:1')?.repository.projectId).toBe('cliente/app');
  });

  it('riconosce i path con gli slash escapati in JSON', () => {
    const escaped = `{"path":"${root.replace(/\//g, '\\/')}\\/crm-locale\\/src\\/app.ts"}`;

    expect(detector().detect(Buffer.from(escaped), 's:1')?.repository.projectId).toBe(
      'acme/legacy-crm',
    );
  });

  it('rilegge il repository quando la cache scade', () => {
    const instance = detector();
    const start = 1_000_000;
    mkdirSync(join(root, 'nuovo'), { recursive: true });
    const request = body({ text: `${root}/nuovo/src/a.ts` });

    expect(instance.detect(request, 's:cache', start)).toBeUndefined();

    makeRepo(['nuovo'], 'git@gitlab.com:acme/nuovo.git');
    expect(instance.detect(request, 's:cache', start + 1_000)).toBeUndefined();
    expect(instance.detect(request, 's:cache', start + 11 * 60_000)?.repository.projectId).toBe(
      'acme/nuovo',
    );
  });

  it('ignora i path fuori dai root configurati', () => {
    const request = body({ text: '/etc/passwd /usr/local/bin/node /altrove/progetto/src/x.ts' });

    expect(detector().detect(request, 's:1')).toBeUndefined();
  });

  it('ignora le cartelle che non sono progetti', () => {
    const request = body({ text: `${root}/scratch/notes/todo.md` });

    expect(detector().detect(request, 's:1')).toBeUndefined();
  });

  it('non attribuisce al repository di una skill installata sotto le cartelle degli strumenti', () => {
    makeRepo(['.copilot', 'marketplaces', 'skills'], 'https://github.com/mattpocock/skills.git');
    makeRepo(['Library', 'Caches', 'plugins', 'skills'], 'https://github.com/mattpocock/skills.git');
    const skill = `${root}/.copilot/marketplaces/skills/skills/tdd`;
    const request = body({
      messages: [
        { role: 'user', content: `${root}/crm-locale/src/app.ts` },
        {
          role: 'assistant',
          content: `${skill}/SKILL.md ${skill}/tests.md ${skill}/mocking.md ${root}/Library/Caches/plugins/skills/a.md`,
        },
      ],
    });

    expect(detector().detect(request, 's:1')?.repository.projectId).toBe('acme/legacy-crm');
  });

  it('riconosce i worktree degli agenti sotto le cartelle degli strumenti', () => {
    const main = join(root, 'worktree-main');
    makeRepo(['worktree-main'], 'git@gitlab.com:acme/agente.git');
    const worktree = join(root, '.codex', 'worktrees', 'a1b2', 'agente');
    mkdirSync(join(main, '.git', 'worktrees', 'agente'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'agente', 'commondir'), '../..\n');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'agente')}\n`);

    const request = body({ text: `${worktree}/src/index.ts` });
    expect(detector().detect(request, 's:1')?.repository.projectId).toBe('acme/agente');
  });

  it('attribuisce al clone accanto un worktree <repo>.worktrees gia cancellato', () => {
    makeRepo(['cliente', 'server-node'], 'git@gitlab.com:cliente/prodotto/server-node.git');
    // Solo la cartella contenitore: il worktree del task non esiste piu'.
    mkdirSync(join(root, 'cliente', 'server-node.worktrees'), { recursive: true });
    const gone = join(root, 'cliente', 'server-node.worktrees', 'sentry-issue-42-fix');

    expect(detector().resolve(gone)?.projectId).toBe('cliente/prodotto/server-node');
    expect(detector().detect(body({ text: `${gone}/src/app.ts` }), 's:1')?.repository.projectId).toBe(
      'cliente/prodotto/server-node',
    );
  });

  it('non inventa un clone per un .worktrees senza repository accanto', () => {
    expect(detector().resolve(join(root, 'orfano.worktrees', 'task'))).toBeUndefined();
  });

  it('resta inattivo senza root configurati', () => {
    const instance = new ProjectDetector({
      roots: [],
      markers: ['.git'],
      stickyTtlMs: 60_000,
      maxScanBytes: 1024,
    });

    expect(instance.enabled).toBe(false);
    expect(
      instance.detect(body({ text: `${root}/acme/cartella-a-caso/src/a.ts` }), 's:1'),
    ).toBeUndefined();
  });
});
