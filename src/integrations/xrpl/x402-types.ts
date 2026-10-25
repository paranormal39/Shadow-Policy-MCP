/**
 * x402 v2 wire types for the XRPL "exact" scheme, plus header codecs.
 *
 * Reference: x402 v2 spec + T54 XRPL facilitator docs. x402 carries all
 * protocol data in three base64-JSON HTTP headers:
 *   PAYMENT-REQUIRED   (server -> client)  — the payment challenge
 *   PAYMENT-SIGNATURE  (client -> server)  — the signed payment payload
 *   PAYMENT-RESPONSE   (server -> client)  — the settlement result
 */

export const X402_VERSION = 2 as const;

export const X402_HEADERS = {
  required: 'PAYMENT-REQUIRED',
  signature: 'PAYMENT-SIGNATURE',
  response: 'PAYMENT-RESPONSE',
} as const;

/** A single accepted payment option (the XRPL "exact" scheme). */
export interface X402Accepted {
  scheme: 'exact';
  /** CAIP-2 network id, e.g. "xrpl:1" (testnet). */
  network: string;
  /** "XRP" or an issued-asset currency hex. */
  asset: string;
  /** Destination (merchant) address. */
  payTo: string;
  /** Amount: drops for XRP, decimal string for issued assets. */
  amount: string;
  maxTimeoutSeconds: number;
  extra?: {
    sourceTag?: number;
    issuer?: string;
    invoiceId?: string;
    [k: string]: unknown;
  };
}

/** The PAYMENT-REQUIRED challenge body. */
export interface PaymentRequired {
  x402Version: typeof X402_VERSION;
  accepts: X402Accepted[];
  /** Opaque resource identifier the payment unlocks. */
  resource?: string;
  description?: string;
}

/** The PAYMENT-SIGNATURE body produced by the paying agent. */
export interface PaymentPayload {
  x402Version: typeof X402_VERSION;
  accepted: X402Accepted;
  payload: {
    /** Hex-encoded signed XRPL Payment tx blob (real path), or a mock blob. */
    signedTxBlob: string;
  };
}

/** The PAYMENT-RESPONSE settlement result. */
export interface SettlementResponse {
  success: boolean;
  network?: string;
  txHash?: string;
  payer?: string;
  errorReason?: string;
}

export function encodeHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

export function decodeHeader<T>(header: string): T {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as T;
}
