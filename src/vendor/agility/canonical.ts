/**
 * Vendored from AgilityCore (@agility-protocol/headless, src/utils/canonical.ts).
 * Copied verbatim so hashes/signatures match the Agility ecosystem while keeping
 * this repo self-contained (deployable without the sibling package). MIT.
 */
import { createHash } from 'node:crypto';

export function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortObjectKeys(obj));
}

function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  if (typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    for (const key of keys) sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
    return sorted;
  }
  return obj;
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
