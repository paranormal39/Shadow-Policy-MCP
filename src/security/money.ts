/**
 * Money helpers. XRP is handled as integer *drops* (1 XRP = 1,000,000 drops)
 * using BigInt — never floating point.
 */
const DROPS_PER_XRP = 1_000_000n;

/** Parse a decimal XRP string (e.g. "0.5", "1", "2.25") into drops. */
export function xrpToDrops(xrp: string): string {
  const trimmed = xrp.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid XRP amount: "${xrp}"`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > 6) {
    throw new Error(`XRP amount "${xrp}" has more than 6 decimal places (sub-drop precision).`);
  }
  const fracPadded = (frac + '000000').slice(0, 6);
  const drops = BigInt(whole) * DROPS_PER_XRP + BigInt(fracPadded || '0');
  return drops.toString();
}

/** Format a drops integer string as a decimal XRP string. */
export function dropsToXrp(drops: string): string {
  const d = BigInt(drops);
  const whole = d / DROPS_PER_XRP;
  const frac = d % DROPS_PER_XRP;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}

export function addDrops(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

/** -1 if a<b, 0 if equal, 1 if a>b. */
export function compareDrops(a: string, b: string): -1 | 0 | 1 {
  const av = BigInt(a);
  const bv = BigInt(b);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

export function isValidDrops(value: string): boolean {
  return /^\d+$/.test(value);
}
