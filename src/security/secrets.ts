/**
 * Secret redaction. Nothing resembling a seed, private key, signed blob, or
 * bearer token must ever reach a tool response or a log line.
 */
const SENSITIVE_KEY = /(seed|secret|privatekey|private_key|mnemonic|apikey|api_key|authorization|password|signedtxblob|signed_tx_blob|txblob)/i;

const SENSITIVE_VALUE_HINTS = [
  /^s[1-9A-HJ-NP-Za-km-z]{25,}$/, // XRPL family seed (starts with s...)
  /^sdk_[0-9a-f]{12}\.[A-Za-z0-9_-]{20,}$/, // votechain per-client api key
];

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return SENSITIVE_VALUE_HINTS.some((re) => re.test(value)) ? '[redacted]' : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/** Redacting console logger — safe to use anywhere in the server. */
export const safeLog = {
  info(msg: string, meta?: unknown) {
    process.stderr.write(`[info] ${msg} ${meta ? JSON.stringify(redact(meta)) : ''}\n`);
  },
  warn(msg: string, meta?: unknown) {
    process.stderr.write(`[warn] ${msg} ${meta ? JSON.stringify(redact(meta)) : ''}\n`);
  },
  error(msg: string, meta?: unknown) {
    process.stderr.write(`[error] ${msg} ${meta ? JSON.stringify(redact(meta)) : ''}\n`);
  },
};
