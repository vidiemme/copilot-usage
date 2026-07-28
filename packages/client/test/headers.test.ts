import { describe, expect, it } from 'vitest';
import { buildDownstreamHeaders, buildUpstreamHeaders } from '../src/proxy/headers.js';

const options = {
  projectHeader: 'x-project-id',
  upstreamHost: 'api.githubcopilot.com',
  overrideAuthToken: undefined,
};

describe('header verso upstream', () => {
  it('forza identity per non ricevere uno stream compresso', () => {
    const headers = buildUpstreamHeaders({ 'accept-encoding': 'gzip, br' }, options);
    expect(headers.get('accept-encoding')).toBe('identity');
  });

  it('rimuove hop-by-hop e header interni al proxy', () => {
    const headers = buildUpstreamHeaders(
      {
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
        'proxy-authorization': 'Basic xxx',
        'x-project-id': 'acme',
        'x-developer-id': 'mrossi',
        'content-length': '10',
        host: 'proxy.interno',
        authorization: 'Bearer ghu_reale',
      },
      options,
    );

    for (const name of [
      'connection',
      'transfer-encoding',
      'proxy-authorization',
      'x-project-id',
      'x-developer-id',
      'content-length',
    ]) {
      expect(headers.get(name), name).toBeNull();
    }

    expect(headers.get('host')).toBe('api.githubcopilot.com');
    expect(headers.get('authorization')).toBe('Bearer ghu_reale');
  });

  it('sostituisce il token quando configurato', () => {
    const headers = buildUpstreamHeaders(
      { authorization: 'Bearer originale' },
      { ...options, overrideAuthToken: 'sostituito' },
    );
    expect(headers.get('authorization')).toBe('Bearer sostituito');
  });
});

describe('header verso client', () => {
  it('mantiene il content-type e scarta lunghezza e codifica', () => {
    const upstream = new Headers({
      'content-type': 'text/event-stream',
      'content-length': '1234',
      'content-encoding': 'gzip',
      connection: 'keep-alive',
      'x-request-id': 'abc',
    });

    const out = buildDownstreamHeaders(upstream);

    expect(out['content-type']).toBe('text/event-stream');
    expect(out['x-request-id']).toBe('abc');
    expect(out['content-length']).toBeUndefined();
    expect(out['content-encoding']).toBeUndefined();
    expect(out['connection']).toBeUndefined();
  });
});
