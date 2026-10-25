/**
 * Hashing / signing helpers.
 *
 * Reuses AgilityCore's canonical JSON + SHA-256 so hashes computed here match
 * the rest of the Agility ecosystem, and adds HMAC receipt signing.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, sha256Hex } from '@agility-protocol/headless';

export { canonicalJson, sha256Hex };

/** Deterministic SHA-256 hex of any JSON-serialisable value. */
export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** HMAC-SHA256 signature (hex) over a canonical JSON payload. */
export function signPayload(secret: string, payload: unknown): string {
  return createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex');
}

/** Constant-time verification of an HMAC signature. */
export function verifyPayload(secret: string, payload: unknown, signature: string): boolean {
  const expected = signPayload(secret, payload);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
