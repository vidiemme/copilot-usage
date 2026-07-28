import { describe, expect, it } from 'vitest';
import { isAbsolute } from 'node:path';
import { loadConfig, type ConfigSource } from '../src/config.js';

const MINIMAL: ConfigSource = {
  COLLECTOR_URL: 'https://raccolta.interno/v1/usage',
  COLLECTOR_TOKEN: 'a'.repeat(64),
  DEVELOPER_ID_SALT: 'b'.repeat(64),
};

describe('loadConfig', () => {
  it('legge dalla sorgente passata invece che da process.env', () => {
    const config = loadConfig({ ...MINIMAL, PORT: '9000' });
    expect(config.port).toBe(9000);
    expect(config.collectorUrl).toBe('https://raccolta.interno/v1/usage');
  });

  it('applica i default quando la chiave manca', () => {
    const config = loadConfig(MINIMAL);
    expect(config.port).toBe(8787);
    expect(config.host).toBe('127.0.0.1');
    expect(config.upstreamBaseUrl).toBe('https://api.githubcopilot.com');
    expect(config.projectMarkers).toEqual(['.git', '.hg', '.svn']);
  });

  it("usa uno spool assoluto: sotto npx la working directory e' arbitraria", () => {
    expect(isAbsolute(loadConfig(MINIMAL).spoolPath)).toBe(true);
  });

  it('ignora i valori vuoti e ricade sul default', () => {
    const config = loadConfig({ ...MINIMAL, HOST: '   ', LOG_LEVEL: '' });
    expect(config.host).toBe('127.0.0.1');
    expect(config.logLevel).toBe('info');
  });

  it('taglia le barre finali dello upstream per non produrre URL doppi', () => {
    const config = loadConfig({ ...MINIMAL, UPSTREAM_BASE_URL: 'https://api.esempio.com///' });
    expect(config.upstreamBaseUrl).toBe('https://api.esempio.com');
  });

  it('rifiuta un collector in chiaro fuori da localhost', () => {
    expect(() => loadConfig({ ...MINIMAL, COLLECTOR_URL: 'http://raccolta.interno/v1/usage' })).toThrow(
      /https/,
    );
  });

  it('accetta http su localhost, dove non esce nulla dalla macchina', () => {
    const config = loadConfig({ ...MINIMAL, COLLECTOR_URL: 'http://127.0.0.1:8080/v1/usage' });
    expect(config.collectorUrl).toBe('http://127.0.0.1:8080/v1/usage');
  });

  it('pretende un salt reale: senza, gli pseudonimi sarebbero invertibili', () => {
    expect(() => loadConfig({ ...MINIMAL, DEVELOPER_ID_SALT: 'change-me' })).toThrow(/DEVELOPER_ID_SALT/);
    expect(() => loadConfig({ ...MINIMAL, DEVELOPER_ID_SALT: '' })).toThrow(/DEVELOPER_ID_SALT/);
  });

  it('segnala quale chiave manca', () => {
    expect(() => loadConfig({ ...MINIMAL, COLLECTOR_TOKEN: undefined })).toThrow(/COLLECTOR_TOKEN/);
  });
});
