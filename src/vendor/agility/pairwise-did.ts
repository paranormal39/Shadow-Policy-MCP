/**
 * Vendored from AgilityCore (@agility-protocol/headless, src/did/PairwiseDid.ts).
 * Deterministic per-audience DID derivation, copied verbatim. MIT.
 */
import { createHash } from 'node:crypto';

/** did:agility:pairwise:<hex> — deterministic: same inputs → same output. */
export function derivePairwiseDid(masterDid: string, audience: string): string {
  const input = `${masterDid}|${audience}`;
  const hash = createHash('sha256').update(input).digest('hex');
  return `did:agility:pairwise:${hash.slice(0, 32)}`;
}

export function isPairwiseDid(did: string): boolean {
  return did.startsWith('did:agility:pairwise:');
}
