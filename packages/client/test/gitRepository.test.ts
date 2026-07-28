import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRemoteUrl, readRepositoryIdentity } from '../src/gitRepository.js';

let root: string;

function makeRepo(name: string, remoteUrl?: string): string {
  const directory = join(root, name);
  mkdirSync(join(directory, '.git'), { recursive: true });
  writeFileSync(
    join(directory, '.git', 'config'),
    ['[core]', '\tbare = false', ...(remoteUrl ? ['[remote "origin"]', `\turl = ${remoteUrl}`] : [])].join(
      '\n',
    ),
  );
  return directory;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'git-identity-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseRemoteUrl', () => {
  it.each([
    ['git@gitlab.com:vidiemme/red_tech/tools/proxy.git', 'gitlab.com', ['vidiemme', 'red_tech', 'tools', 'proxy']],
    ['https://github.com/vidiemme/portal.git', 'github.com', ['vidiemme', 'portal']],
    ['ssh://git@git.interno:2222/team/sub/app.git', 'git.interno', ['team', 'sub', 'app']],
    ['https://tizio@bitbucket.org/acme/crm', 'bitbucket.org', ['acme', 'crm']],
    ['git://github.com/acme/lib.git', 'github.com', ['acme', 'lib']],
  ])('scompone %s', (url, host, segments) => {
    expect(parseRemoteUrl(url)).toEqual({ host, segments });
  });

  it('riduce i percorsi locali al solo nome', () => {
    expect(parseRemoteUrl('/srv/git/acme.git')).toEqual({ host: null, segments: ['acme'] });
  });
});

describe('readRepositoryIdentity', () => {
  it('usa il percorso sul server Git, non il nome della cartella locale', () => {
    const directory = makeRepo(
      'nome-scelto-a-caso',
      'git@gitlab.com:vidiemme/red_tech/tools/proxy.git',
    );

    expect(readRepositoryIdentity(directory)).toEqual({
      projectId: 'vidiemme/red_tech/tools/proxy',
      host: 'gitlab.com',
      groups: ['vidiemme', 'red_tech', 'tools'],
      name: 'proxy',
      remoteUrl: 'git@gitlab.com:vidiemme/red_tech/tools/proxy.git',
    });
  });

  it('due cloni con nomi diversi producono lo stesso progetto', () => {
    const first = makeRepo('portal', 'https://github.com/vidiemme/portal.git');
    const second = makeRepo('portal-mio-fork-locale', 'https://github.com/vidiemme/portal.git');

    expect(readRepositoryIdentity(first).projectId).toBe(
      readRepositoryIdentity(second).projectId,
    );
  });

  it('ripiega sul nome della cartella quando manca il remote', () => {
    const directory = makeRepo('progetto-locale');

    expect(readRepositoryIdentity(directory)).toEqual({
      projectId: 'progetto-locale',
      host: null,
      groups: [],
      name: 'progetto-locale',
      remoteUrl: null,
    });
  });

  it('preferisce origin agli altri remote', () => {
    const directory = join(root, 'multi-remote');
    mkdirSync(join(directory, '.git'), { recursive: true });
    writeFileSync(
      join(directory, '.git', 'config'),
      [
        '[remote "fork"]',
        '\turl = git@github.com:tizio/app.git',
        '[remote "origin"]',
        '\turl = git@github.com:acme/app.git',
      ].join('\n'),
    );

    expect(readRepositoryIdentity(directory).projectId).toBe('acme/app');
  });

  it('segue il puntatore .git di un worktree', () => {
    const main = makeRepo('main-repo', 'git@github.com:acme/app.git');
    const worktree = join(root, 'app-hotfix');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'hotfix')}\n`);

    expect(readRepositoryIdentity(worktree).projectId).toBe('acme/app');
  });
});
