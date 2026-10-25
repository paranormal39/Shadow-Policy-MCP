import { describe, expect, it } from 'vitest';
import { redact } from '../src/security/secrets.js';

describe('redact', () => {
  it('redacts sensitive keys', () => {
    const out = redact({ apiKey: 'sdk_abc', seed: 'sEd...', nested: { privateKey: 'x' }, title: 'ok' }) as Record<string, unknown>;
    expect(out.apiKey).toBe('[redacted]');
    expect(out.seed).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).privateKey).toBe('[redacted]');
    expect(out.title).toBe('ok');
  });

  it('redacts values that look like XRPL seeds or api keys', () => {
    const out = redact({ note: 'sn9KVQ3zq6a4Hc2pRhhh2mE3x9abcdef12', key: 'sdk_0123456789ab.AbCdEfGhIjKlMnOpQrStUvWx' }) as Record<string, unknown>;
    expect(out.note).toBe('[redacted]');
    expect(out.key).toBe('[redacted]');
  });

  it('passes through ordinary data', () => {
    expect(redact({ a: 1, b: ['x', 'y'] })).toEqual({ a: 1, b: ['x', 'y'] });
  });
});
