/**
 * In-memory idempotency store. A client that retries an operation with the same
 * idempotency key gets the original result back instead of triggering a second
 * payment or a duplicate poll.
 *
 * Swap this for a durable store (Redis/Postgres) in production via the
 * IdempotencyStore interface.
 */
export interface IdempotencyStore {
  /** Returns the cached result for `key`, or undefined if unseen. */
  get<T>(key: string): T | undefined;
  /** Caches a result for `key`. */
  set<T>(key: string, value: T): void;
  /**
   * Runs `fn` once per key. Concurrent/later calls with the same key resolve to
   * the first in-flight (or cached) result.
   */
  once<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

interface Entry {
  value?: unknown;
  inflight?: Promise<unknown>;
  expiresAt: number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, Entry>();
  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.map) if (v.expiresAt <= now) this.map.delete(k);
  }

  get<T>(key: string): T | undefined {
    this.sweep();
    const e = this.map.get(key);
    return e && 'value' in e ? (e.value as T) : undefined;
  }

  set<T>(key: string, value: T): void {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  async once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.sweep();
    const existing = this.map.get(key);
    if (existing) {
      if ('value' in existing && existing.value !== undefined) return existing.value as T;
      if (existing.inflight) return existing.inflight as Promise<T>;
    }
    const inflight = (async () => {
      const result = await fn();
      this.map.set(key, { value: result, expiresAt: Date.now() + this.ttlMs });
      return result;
    })();
    this.map.set(key, { inflight, expiresAt: Date.now() + this.ttlMs });
    try {
      return (await inflight) as T;
    } catch (err) {
      // Failed attempts must not be cached — allow a genuine retry.
      this.map.delete(key);
      throw err;
    }
  }
}
