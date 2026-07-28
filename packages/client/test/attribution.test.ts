import { describe, expect, it } from 'vitest';
import { resolveAttribution } from '../src/attribution.js';
import type { ClientConfig } from '../src/config.js';

// `resolveAttribution` legge solo questi campi: il resto della configurazione
// non serve al test.
const config = {
  projectHeader: 'x-project-id',
  unassignedProject: 'unassigned',
  developerIdSalt: 'test-salt',
  attributionTokens: { 'tok-abc': { projectId: 'legacy-crm', developerId: 'mrossi' } },
} as unknown as ClientConfig;

describe('attribuzione', () => {
  it('preferisce il prefisso di path', () => {
    const result = resolveAttribution(
      { path: '/p/acme-portal/v1/messages', headers: { 'x-project-id': 'altro' } },
      config,
    );

    expect(result.projectId).toBe('acme-portal');
    expect(result.projectSource).toBe('path');
    expect(result.upstreamPath).toBe('/v1/messages');
  });

  it('legge developer e progetto dai prefissi combinati', () => {
    const result = resolveAttribution(
      { path: '/u/g.carassale/p/acme-portal/chat/completions', headers: {} },
      config,
    );

    expect(result.developerId).toBe('g.carassale');
    expect(result.developerSource).toBe('path');
    expect(result.projectId).toBe('acme-portal');
    expect(result.projectSource).toBe('path');
    expect(result.upstreamPath).toBe('/chat/completions');
  });

  it('accetta i prefissi in ordine inverso', () => {
    const result = resolveAttribution(
      { path: '/p/acme-portal/u/g.carassale/chat/completions', headers: {} },
      config,
    );

    expect(result.developerId).toBe('g.carassale');
    expect(result.projectId).toBe('acme-portal');
    expect(result.upstreamPath).toBe('/chat/completions');
  });

  it('il prefisso developer vince sullo pseudonimo del token', () => {
    const result = resolveAttribution(
      { path: '/u/g.carassale/v1/messages', headers: { authorization: 'Bearer ghu_xxx' } },
      config,
    );

    expect(result.developerId).toBe('g.carassale');
    expect(result.developerSource).toBe('path');
  });

  it('usa l header di progetto', () => {
    const result = resolveAttribution(
      { path: '/v1/messages', headers: { 'x-project-id': 'Acme Portal' } },
      config,
    );

    expect(result.projectId).toBe('acme-portal');
    expect(result.projectSource).toBe('header');
  });

  it('usa lo username delle credenziali proxy', () => {
    const basic = Buffer.from('acme-portal:segreto').toString('base64');
    const result = resolveAttribution(
      { path: '/chat/completions', headers: { 'proxy-authorization': `Basic ${basic}` } },
      config,
    );

    expect(result.projectId).toBe('acme-portal');
    expect(result.projectSource).toBe('proxy-auth');
  });

  it('risolve dalla mappa token', () => {
    const result = resolveAttribution(
      { path: '/v1/messages', headers: { authorization: 'Bearer tok-abc' } },
      config,
    );

    expect(result.projectId).toBe('legacy-crm');
    expect(result.developerId).toBe('mrossi');
    expect(result.projectSource).toBe('token');
  });

  it('ripiega su unassigned e pseudonimizza il developer', () => {
    const result = resolveAttribution(
      { path: '/v1/messages', headers: { authorization: 'Bearer ghu_xxx' } },
      config,
    );

    expect(result.projectId).toBe('unassigned');
    expect(result.projectSource).toBe('fallback');
    expect(result.developerSource).toBe('pseudonym');
    expect(result.developerId).toMatch(/^[0-9a-f]{16}$/);
    expect(result.developerId).not.toContain('ghu_');
  });

  it('lo pseudonimo e stabile per lo stesso token', () => {
    const build = () =>
      resolveAttribution({ path: '/v1/messages', headers: { authorization: 'Bearer t' } }, config)
        .developerId;

    expect(build()).toBe(build());
  });

  it('lo pseudonimo resiste alla rotazione del token Copilot', () => {
    // Il token Copilot viene rinnovato di continuo: cambiano `exp` e la firma,
    // ma la persona e' la stessa.
    const build = (exp: number, signature: string) =>
      resolveAttribution(
        {
          path: '/chat/completions',
          headers: {
            authorization: `Bearer tid=abc123;u=99887;exp=${exp};sku=copilot_enterprise;chat=1:${signature}`,
          },
        },
        config,
      ).developerId;

    expect(build(1784980000, 'firma-vecchia')).toBe(build(1784990000, 'firma-nuova'));
  });

  it('distingue comunque due persone diverse', () => {
    const build = (user: string) =>
      resolveAttribution(
        { path: '/chat/completions', headers: { authorization: `Bearer tid=abc;u=${user};exp=1` } },
        config,
      ).developerId;

    expect(build('99887')).not.toBe(build('11223'));
  });

  it('scarta prefissi di path non validi', () => {
    const result = resolveAttribution({ path: '/p/../../etc/passwd', headers: {} }, config);
    expect(result.projectId).toBe('unassigned');
    expect(result.upstreamPath).toBe('/p/../../etc/passwd');
  });
});
