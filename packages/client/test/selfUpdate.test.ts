import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { entryFromServiceFile, runsAsService, startupScript } from '../src/autostart.js';
import { loadConfig } from '../src/config.js';
import {
  installTarget,
  installUpdate,
  pickUpdate,
  SelfUpdater,
  UPDATE_MIN_AGE_MS,
  type InstallTarget,
  type Packument,
} from '../src/selfUpdate.js';
import { CLIENT_VERSION } from '../src/version.js';

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
    expect(pickUpdate(doc, '0.7.2', NOW)).toBe('0.7.4');
  });

  it('passa anche a una nuova minor o major', () => {
    const doc = packument({ '0.7.2': OLD, '0.8.0': OLD, '1.0.0': OLD }, '1.0.0');
    expect(pickUpdate(doc, '0.7.2', NOW)).toBe('1.0.0');
  });

  it('sceglie la versione stabile piu recente anche da una vecchia minor', () => {
    const doc = packument({ '0.8.1': OLD, '0.9.1': OLD, '0.10.2': OLD, '0.11.0': OLD }, '0.11.0');
    expect(pickUpdate(doc, '0.8.1', NOW)).toBe('0.11.0');
    expect(pickUpdate(doc, '0.9.0', NOW)).toBe('0.11.0');
    expect(pickUpdate(doc, '0.10.1', NOW)).toBe('0.11.0');
  });

  it("aspetta che la versione abbia l'eta' minima", () => {
    const doc = packument({ '0.7.2': OLD, '0.7.3': OLD, '0.7.4': FRESH }, '0.7.4');
    expect(pickUpdate(doc, '0.7.2', NOW)).toBe('0.7.3');
  });

  it('aspetta anche per una nuova minor e sceglie una versione precedente gia stabile', () => {
    const doc = packument({ '0.9.0': OLD, '0.10.1': OLD, '0.11.0': FRESH }, '0.11.0');
    expect(pickUpdate(doc, '0.9.0', NOW)).toBe('0.10.1');
  });

  it('salta deprecate, prerelease e versioni oltre latest', () => {
    const doc = packument(
      { '0.7.2': OLD, '0.7.3': OLD, '0.7.4': OLD, '0.7.5-beta.1': OLD, '0.7.5': OLD },
      '0.7.4',
      ['0.7.4'],
    );
    expect(pickUpdate(doc, '0.7.2', NOW)).toBe('0.7.3');
  });

  it('non torna indietro', () => {
    const doc = packument({ '0.9.9': OLD, '0.10.2': OLD, '1.0.0': OLD }, '0.10.2');
    expect(pickUpdate(doc, '1.0.0', NOW)).toBeUndefined();
    expect(pickUpdate(doc, '0.10.2', NOW)).toBeUndefined();
  });

  it('non supera latest anche quando una major successiva e gia pubblicata', () => {
    const doc = packument({ '0.8.1': OLD, '0.10.2': OLD, '1.0.0': OLD }, '0.10.2');
    expect(pickUpdate(doc, '0.8.1', NOW)).toBe('0.10.2');
  });

  it('non installa una prerelease ne quando latest non e stabile', () => {
    const doc = packument({ '0.8.1': OLD, '0.9.0-beta.1': OLD }, '0.9.0-beta.1');
    expect(pickUpdate(doc, '0.8.1', NOW)).toBeUndefined();
  });
});

describe("ciclo dell'aggiornamento automatico", () => {
  let dir: string;
  let target: InstallTarget;
  let updater: SelfUpdater | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    dir = mkdtempSync(join(tmpdir(), 'self-update-cycle-'));
    target = { prefix: dir, packageDir: join(dir, 'package'), npmCli: join(dir, 'npm-cli.js') };
    mkdirSync(target.packageDir);
    writeFileSync(join(target.packageDir, 'package.json'), JSON.stringify({ version: CLIENT_VERSION }));
  });

  afterEach(() => {
    updater?.close();
    updater = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("installa una nuova minor e aspetta la fine delle richieste prima di riavviare", async () => {
    const fetchPackument = vi.fn(async () => packument({ '9.0.0': OLD }, '9.0.0'));
    const install = vi.fn(async (_target: InstallTarget, _version: string): Promise<void> => {});
    const restart = vi.fn();
    let idleSince: number | undefined;
    updater = new SelfUpdater({ idleSince: () => idleSince, restart }, { target, fetchPackument, install });
    updater.start(Fastify({ logger: false }).log);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(install).toHaveBeenCalledWith(target, '9.0.0');
    expect(updater.status().pending).toBe('9.0.0');
    expect(restart).not.toHaveBeenCalled();

    idleSince = Date.now() - 30_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(restart).toHaveBeenCalledOnce();
  });

  it.each(['9.0.0', '0.1.0'])("non sovrascrive la versione %s installata dall'operatore", async (version) => {
    writeFileSync(join(target.packageDir, 'package.json'), JSON.stringify({ version }));
    const fetchPackument = vi.fn(async () => packument({ '8.0.0': OLD }, '8.0.0'));
    const install = vi.fn(async (_target: InstallTarget, _version: string): Promise<void> => {});
    const restart = vi.fn();
    let idleSince: number | undefined;
    updater = new SelfUpdater({ idleSince: () => idleSince, restart }, { target, fetchPackument, install });
    updater.start(Fastify({ logger: false }).log);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(fetchPackument).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(updater.status().pending).toBe(version);
    expect(restart).not.toHaveBeenCalled();
    idleSince = Date.now() - 30_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(restart).toHaveBeenCalledOnce();
  });

  it('rispetta la disattivazione esplicita', async () => {
    const fetchPackument = vi.fn(async () => packument({ '9.0.0': OLD }, '9.0.0'));
    const install = vi.fn(async (_target: InstallTarget, _version: string): Promise<void> => {});
    updater = new SelfUpdater(
      { disabledReason: 'disattivato dalla configurazione', idleSince: () => undefined, restart: vi.fn() },
      { target, fetchPackument, install },
    );
    updater.start(Fastify({ logger: false }).log);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(updater.status()).toMatchObject({ enabled: false, reason: 'disattivato dalla configurazione' });
    expect(fetchPackument).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("segnala un'installazione non leggibile senza modificarla", async () => {
    rmSync(join(target.packageDir, 'package.json'));
    const fetchPackument = vi.fn(async () => packument({ '9.0.0': OLD }, '9.0.0'));
    const install = vi.fn(async (_target: InstallTarget, _version: string): Promise<void> => {});
    updater = new SelfUpdater({ idleSince: () => undefined, restart: vi.fn() }, { target, fetchPackument, install });
    updater.start(Fastify({ logger: false }).log);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(fetchPackument).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(updater.status().lastError).toContain('versione installata');
  });

  it("espone un errore d'installazione e riprova al controllo successivo", async () => {
    const fetchPackument = vi.fn(async () => packument({ '9.0.0': OLD }, '9.0.0'));
    const install = vi.fn(async (_target: InstallTarget, _version: string): Promise<void> => {});
    install.mockRejectedValueOnce(new Error('installazione fallita'));
    const restart = vi.fn();
    updater = new SelfUpdater({ idleSince: () => undefined, restart }, { target, fetchPackument, install });
    updater.start(Fastify({ logger: false }).log);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(updater.status().lastError).toBe('installazione fallita');
    expect(updater.status().pending).toBeUndefined();
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(install).toHaveBeenCalledTimes(2);
    expect(updater.status().pending).toBe('9.0.0');
    expect(updater.status().lastError).toBeUndefined();
  });

  it("non avvia un'installazione se il proxy si arresta durante il controllo", async () => {
    let resolveFetch: ((doc: Packument) => void) | undefined;
    const fetchPackument = vi.fn(() => new Promise<Packument>((resolve) => { resolveFetch = resolve; }));
    const install = vi.fn(async (_target: InstallTarget, _version: string): Promise<void> => {});
    updater = new SelfUpdater({ idleSince: () => undefined, restart: vi.fn() }, { target, fetchPackument, install });
    updater.start(Fastify({ logger: false }).log);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(fetchPackument).toHaveBeenCalledOnce();
    updater.close();
    if (!resolveFetch) throw new Error('controllo del registry non avviato');
    resolveFetch(packument({ '9.0.0': OLD }, '9.0.0'));
    await Promise.resolve();
    expect(install).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("installazione dell'aggiornamento", () => {
  let dir: string;
  let target: InstallTarget;
  let argsFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'self-update-install-'));
    target = { prefix: dir, packageDir: join(dir, 'package'), npmCli: join(dir, 'npm-cli.cjs') };
    argsFile = join(dir, 'args.json');
    mkdirSync(target.packageDir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('usa npm con engine-strict nello stesso prefisso e verifica la versione installata', async () => {
    writeFileSync(target.npmCli, `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
      fs.writeFileSync(${JSON.stringify(join(target.packageDir, 'package.json'))}, JSON.stringify({ version: '9.0.0' }));
    `);

    await installUpdate(target, '9.0.0');
    expect(JSON.parse(readFileSync(argsFile, 'utf-8'))).toEqual([
      'install',
      '--global',
      '--prefix',
      target.prefix,
      '--engine-strict',
      '--no-audit',
      '--no-fund',
      '@vidiemme/copilot-proxy@9.0.0',
    ]);
  });

  it('segnala una versione diversa da quella richiesta', async () => {
    writeFileSync(target.npmCli, `
      require('node:fs').writeFileSync(
        ${JSON.stringify(join(target.packageDir, 'package.json'))}, JSON.stringify({ version: '8.0.0' }),
      );
    `);
    await expect(installUpdate(target, '9.0.0')).rejects.toThrow("contiene la 8.0.0, attesa la 9.0.0");
  });

  it('propaga un errore del processo npm', async () => {
    writeFileSync(target.npmCli, "process.stderr.write('engine incompatible'); process.exitCode = 1;");
    await expect(installUpdate(target, '9.0.0')).rejects.toThrow('engine incompatible');
  });

  it('npm con engine-strict rifiuta un Node incompatibile senza sostituire il pacchetto', async () => {
    const globalRoot = process.platform === 'win32' ? join(dir, 'node_modules') : join(dir, 'lib', 'node_modules');
    const installedDir = join(globalRoot, '@vidiemme', 'copilot-proxy');
    const incomingDir = join(dir, 'incoming');
    mkdirSync(installedDir, { recursive: true });
    mkdirSync(incomingDir);
    writeFileSync(join(installedDir, 'package.json'), JSON.stringify({ name: '@vidiemme/copilot-proxy', version: CLIENT_VERSION }));
    writeFileSync(join(incomingDir, 'package.json'), JSON.stringify({
      name: '@vidiemme/copilot-proxy',
      version: '9.0.0',
      engines: { node: '>=999.0.0' },
    }));

    const actualTarget = installTarget(join(installedDir, 'dist', 'cli.js'), process.execPath);
    if ('reason' in actualTarget) throw new Error(actualTarget.reason);
    await expect(promisify(execFile)(process.execPath, [
      actualTarget.npmCli,
      'install',
      '--global',
      '--prefix',
      dir,
      '--engine-strict',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      incomingDir,
    ])).rejects.toThrow('EBADENGINE');
    expect(JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf-8')).version).toBe(CLIENT_VERSION);
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
