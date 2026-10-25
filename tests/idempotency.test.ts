import { describe, expect, it } from 'vitest';
import { InMemoryIdempotencyStore } from '../src/security/idempotency.js';

describe('InMemoryIdempotencyStore', () => {
  it('runs a keyed operation exactly once for concurrent and repeat calls', async () => {
    const store = new InMemoryIdempotencyStore();
    let calls = 0;
    const op = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { n: calls };
    };
    const [a, b] = await Promise.all([store.once('k', op), store.once('k', op)]);
    const c = await store.once('k', op);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(c).toEqual(a);
  });

  it('does not cache failures (allows a genuine retry)', async () => {
    const store = new InMemoryIdempotencyStore();
    let calls = 0;
    const op = async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'ok';
    };
    await expect(store.once('k', op)).rejects.toThrow('boom');
    await expect(store.once('k', op)).resolves.toBe('ok');
    expect(calls).toBe(2);
  });
});
