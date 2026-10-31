import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiUrlFromPsLine, isRuntimeCommand } from '../src/agentRuntime.js';
import {
  applyEditorSettings,
  isOverrideCommented,
  knownEditors,
  pointsToProxy,
  readOverride,
  type Editor,
} from '../src/editors.js';
import { portStatus } from '../src/setupHelpers.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'editors-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function editor(name = 'Cursor'): Editor {
  return { name, settingsFile: join(dir, name, 'User', 'settings.json') };
}

describe('impostazioni degli editor', () => {
  it('copre VS Code e i suoi derivati', () => {
    expect(knownEditors().map((e) => e.name)).toEqual([
      'VS Code',
      'VS Code Insiders',
      'VSCodium',
      'Cursor',
      'Windsurf',
      'Antigravity',
    ]);
  });

  it('aggiunge le chiavi preservando le altre, con backup', () => {
    const target = editor();
    applyEditorSettings(target, 9000);
    writeFileSync(target.settingsFile, JSON.stringify({ 'editor.fontSize': 14 }));

    const result = applyEditorSettings(target, 9001);

    expect(result).toEqual({ status: 'updated', backup: `${target.settingsFile}.bak` });
    expect(JSON.parse(readFileSync(target.settingsFile, 'utf-8'))).toEqual({
      'editor.fontSize': 14,
      'github.copilot.advanced.debug.overrideCapiUrl': 'http://127.0.0.1:9001',
      'github.copilot.advanced.debug.overrideAuthType': 'token',
    });
    expect(readOverride(target)).toBe('http://127.0.0.1:9001');
  });

  it('non tocca un settings.json con commenti', () => {
    const target = editor();
    applyEditorSettings(target, 9000);
    const jsonc = '{\n  // commento\n  "editor.fontSize": 14,\n}\n';
    writeFileSync(target.settingsFile, jsonc);

    expect(applyEditorSettings(target, 9001)).toEqual({ status: 'unparsable' });
    expect(readFileSync(target.settingsFile, 'utf-8')).toBe(jsonc);
    expect(readOverride(target)).toBeNull();
  });

  it('riconosce localhost e 127.0.0.1 sulla porta giusta', () => {
    expect(pointsToProxy('http://localhost:9000/', 9000)).toBe(true);
    expect(pointsToProxy('http://127.0.0.1:9000', 9000)).toBe(true);
    expect(pointsToProxy('http://127.0.0.1:8787', 9000)).toBe(false);
  });

  it("non considera attivo un override commentato, ma lo segnala", () => {
    const target = editor();
    applyEditorSettings(target, 9000);
    writeFileSync(
      target.settingsFile,
      '{\n  "editor.fontSize": 14\n  //"github.copilot.advanced.debug.overrideCapiUrl": "http://127.0.0.1:9000",\n}\n',
    );

    expect(readOverride(target)).toBeNull();
    expect(isOverrideCommented(target)).toBe(true);
  });

  it('legge un override attivo anche su una riga che inizia con la graffa', () => {
    const target = editor();
    applyEditorSettings(target, 9000);
    writeFileSync(target.settingsFile, '{"github.copilot.advanced.debug.overrideCapiUrl": "http://127.0.0.1:9000"}');

    expect(readOverride(target)).toBe('http://127.0.0.1:9000');
    expect(isOverrideCommented(target)).toBe(false);
  });
});

describe('runtime agentico', () => {
  it('riconosce il runtime di VS Code e il binario di Copilot CLI', () => {
    expect(
      isRuntimeCommand(
        '/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked/@github/copilot-sdk-darwin-arm64/prebuilds/darwin-arm64/copilot-runtime --headless --stdio',
      ),
    ).toBe(true);
    expect(
      isRuntimeCommand('/usr/lib/node_modules/@github/copilot/node_modules/@github/copilot-linux-x64/copilot -p ciao'),
    ).toBe(true);
    expect(isRuntimeCommand('node /usr/bin/copilot-proxy start')).toBe(false);
    expect(isRuntimeCommand('node /home/me/.nvm/bin/copilot --help')).toBe(false);
  });

  it("estrae COPILOT_API_URL dall'ambiente stampato da ps", () => {
    expect(apiUrlFromPsLine('/x/copilot-runtime --headless HOME=/Users/me COPILOT_API_URL=http://127.0.0.1:8787 PATH=/bin')).toBe(
      'http://127.0.0.1:8787',
    );
    expect(apiUrlFromPsLine('/x/copilot-runtime --headless HOME=/Users/me MY_COPILOT_API_URL=x')).toBeUndefined();
  });
});

describe('verifica della porta', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
  });

  async function listen(body: object): Promise<number> {
    server = createServer((_req, res) => res.end(JSON.stringify(body)));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  it('distingue porta libera, proxy gia\' attivo e altro programma', async () => {
    const proxyPort = await listen({ ok: true, upstream: 'x', collector: 'y' });
    expect(await portStatus(proxyPort, '127.0.0.1')).toBe('proxy');
    await new Promise((resolve) => server!.close(resolve));

    const otherPort = await listen({ hello: 'world' });
    expect(await portStatus(otherPort, '127.0.0.1')).toBe('busy');
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;

    expect(await portStatus(otherPort, '127.0.0.1')).toBe('free');
  });
});
