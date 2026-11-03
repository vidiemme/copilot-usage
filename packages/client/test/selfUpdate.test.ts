import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { entryFromServiceFile, runsAsService, startupScript } from '../src/autostart.js';
import { loadConfig } from '../src/config.js';
import { installTarget, pickPatchUpdate, UPDATE_MIN_AGE_MS, type Packument } from '../src/selfUpdate.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const OLD = new Date(NOW - UPDATE_MIN_AGE_MS - 1000).toISOString();
const FRESH = new Date(NOW - 60_000).toISOString();

function packument(published: Record<string, string>, latest: string, deprecated: string[] = []): Packument {
  return {
    'dist-tags': { latest },
    time: published,
    versions: Object.fromEntries(
      Object.keys(published).map((version) => [version, deprecated.includes(version) ? { deprecated: 'ritirata' } : {}]),
    ),
  };
}

describe('scelta della versione', () => {
  it("prende la patch piu' recente della stessa minor", () => {
    const doc = packument({ '0.7.2': OLD, '0.7.3': OLD, '0.7.4': OLD }, '0.7.4');
    expect(pickPatchUpdate(doc, '0.7.2', NOW)).toBe('0.7.4');
  });

  it('non passa a una nuova minor o major', () => {
    const doc = packument({ '0.7.2': OLD, '0.8.0': OLD, '1.0.0': OLD }, '1.0.0');
    expect(pickPatchUpdate(doc, '0.7.2', NOW)).toBeUndefined();
  });

  it("aspetta che la versione abbia l'eta' minima", () => {
    const doc = packument({ '0.7.2': OLD, '0.7.3': OLD, '0.7.4': FRESH }, '0.7.4');
    expect(pickPatchUpdate(doc, '0.7.2', NOW)).toBe('0.7.3');
  });

  it('salta deprecate, prerelease e versioni oltre latest', () => {
    const doc = packument(
      { '0.7.2': OLD, '0.7.3': OLD, '0.7.4': OLD, '0.7.5-beta.1': OLD, '0.7.5': OLD },
      '0.7.4',
      ['0.7.4'],
    );
    expect(pickPatchUpdate(doc, '0.7.2', NOW)).toBe('0.7.3');
  });

  it('non torna indietro', () => {
    const doc = packument({ '0.7.1': OLD, '0.7.2': OLD }, '0.7.1');
    expect(pickPatchUpdate(doc, '0.7.2', NOW)).toBeUndefined();
  });
});

// Il prefisso simulato e' quello POSIX (symlink, chmod, `lib/node_modules`):
// su Windows i percorsi temporanei con `\` non sono leggibili come POSIX.
describe.skipIf(process.platform === 'win32')('destinazione dell\'installazione', () => {
  let dir: string;

  beforeEach(() => {
    // Su macOS la cartella temporanea passa da un link: npm-cli.js viene risolto.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'self-update-')));
  });

  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  /** Un prefisso come quello di nvm: `bin/node`, `bin/npm` e `lib/node_modules`. */
  function nodePrefix(name: string): { execPath: string; entry: string; globalRoot: string } {
    const prefix = join(dir, name);
    const globalRoot = join(prefix, 'lib', 'node_modules');
    const npmCli = join(globalRoot, 'npm', 'bin', 'npm-cli.js');
    mkdirSync(join(globalRoot, 'npm', 'bin'), { recursive: true });
    writeFileSync(npmCli, '');
    mkdirSync(join(prefix, 'bin'));
    symlinkSync(npmCli, join(prefix, 'bin', 'npm'));
    mkdirSync(join(globalRoot, '@vidiemme', 'copilot-proxy', 'dist'), { recursive: true });
    return {
      execPath: join(prefix, 'bin', 'node'),
      entry: join(globalRoot, '@vidiemme', 'copilot-proxy', 'dist', 'cli.js'),
      globalRoot,
    };
  }

  it('installa nel prefisso del pacchetto in esecuzione, con il suo npm', () => {
    const node = nodePrefix('v22');
    expect(installTarget(node.entry, node.execPath, 'linux')).toEqual({
      prefix: join(dir, 'v22'),
      packageDir: join(node.globalRoot, '@vidiemme', 'copilot-proxy'),
      npmCli: join(node.globalRoot, 'npm', 'bin', 'npm-cli.js'),
    });
  });

  it("con piu' versioni di Node usa quella del servizio, non un'altra", () => {
    const service = nodePrefix('v22');
    nodePrefix('v24');
    const target = installTarget(service.entry, service.execPath, 'linux');
    expect(target).toMatchObject({ prefix: join(dir, 'v22') });
  });

  it('rinuncia sotto npx e fuori da un prefisso globale', () => {
    expect(installTarget('/home/a/.npm/_npx/abc/node_modules/@vidiemme/copilot-proxy/dist/cli.js', '/usr/bin/node', 'linux')).toEqual({
      reason: 'eseguito con npx',
    });
    expect(installTarget('/home/a/src/copilot-usage/packages/client/dist/cli.js', '/usr/bin/node', 'linux')).toEqual({
      reason: "non e' un'installazione globale di npm",
    });
  });

  it('rinuncia se il prefisso richiede privilegi', () => {
    const node = nodePrefix('system');
    chmodSync(node.globalRoot, 0o500);
    try {
      expect(installTarget(node.entry, node.execPath, 'linux')).toMatchObject({
        reason: expect.stringContaining('non e\' scrivibile'),
      });
    } finally {
      chmodSync(node.globalRoot, 0o700);
    }
  });
});

describe('quando aggiornarsi', () => {
  it('riconosce il processo lanciato dal servizio', () => {
    expect(runsAsService({ XPC_SERVICE_NAME: 'com.vidiemme.copilot-proxy' }, 'darwin')).toBe(true);
    expect(runsAsService({ XPC_SERVICE_NAME: 'application.com.microsoft.VSCode' }, 'darwin')).toBe(false);
    expect(runsAsService({ INVOCATION_ID: 'abc' }, 'linux')).toBe(true);
    expect(runsAsService({}, 'linux')).toBe(false);
    expect(runsAsService({ COPILOT_PROXY_SUPERVISED: '1' }, 'win32')).toBe(true);
  });

  it('si disattiva con AUTO_UPDATE', () => {
    const token = { COLLECTOR_TOKEN: 'a'.repeat(64) };
    expect(loadConfig(token).autoUpdate).toBe(true);
    expect(loadConfig({ ...token, AUTO_UPDATE: 'false' }).autoUpdate).toBe(false);
    expect(loadConfig({ ...token, AUTO_UPDATE: '0' }).autoUpdate).toBe(false);
  });
});

describe('installazione avviata dal servizio', () => {
  it('legge il cli.js dal plist di launchd', () => {
    const plist = `<plist version="1.0">
<dict>
  <key>Label</key><string>com.vidiemme.copilot-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/a/.nvm/versions/node/v22.23.4/bin/node</string>
    <string>/Users/a/.npm/_npx/9374c6867ef579c0/node_modules/@vidiemme/copilot-proxy/dist/cli.js</string>
    <string>start</string>
  </array>
  <key>StandardOutPath</key><string>/Users/a/.config/copilot-proxy/proxy.log</string>
</dict>
</plist>`;
    expect(entryFromServiceFile(plist, 'darwin')).toBe(
      '/Users/a/.npm/_npx/9374c6867ef579c0/node_modules/@vidiemme/copilot-proxy/dist/cli.js',
    );
  });

  it('legge il cli.js dalla unit di systemd', () => {
    const unit = `[Service]
ExecStart=/home/a/.nvm/versions/node/v22.23.4/bin/node /home/a/.nvm/versions/node/v22.23.4/lib/node_modules/@vidiemme/copilot-proxy/dist/cli.js start
Restart=always
`;
    expect(entryFromServiceFile(unit, 'linux')).toBe(
      '/home/a/.nvm/versions/node/v22.23.4/lib/node_modules/@vidiemme/copilot-proxy/dist/cli.js',
    );
  });

  it('legge il cli.js dallo script di Esecuzione automatica', () => {
    const entry = 'C:\\Users\\Mario 100%\\AppData\\Roaming\\npm\\node_modules\\@vidiemme\\copilot-proxy\\dist\\cli.js';
    const script = startupScript('C:\\Program Files\\nodejs\\node.exe', entry, {});
    expect(entryFromServiceFile(script, 'win32')).toBe(entry);
  });
});
