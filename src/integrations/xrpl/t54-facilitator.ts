/**
 * T54XrplFacilitator — talks to T54's hosted XRPL x402 facilitator over HTTP.
 *
 * This is the real-money path (XRPL testnet by default). It is intentionally
 * NOT exercised by the default unit/integration tests, which use the mock
 * facilitator; running it requires network access and a funded XRPL wallet on
 * the agent/client side (the server never signs).
 *
 * The facilitator exposes the standard x402 `/verify` and `/settle` endpoints
 * that accept `{ x402Version, paymentPayload, paymentRequirements }`.
 */
import { safeLog } from '../../security/secrets.js';
import type { PaymentFacilitator, VerifyResult } from './facilitator.js';
import { X402_VERSION, type PaymentPayload, type SettlementResponse, type X402Accepted } from './x402-types.js';

export class T54XrplFacilitator implements PaymentFacilitator {
  readonly kind = 't54' as const;
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) {
      throw new Error(`Facilitator ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    return parsed as T;
  }

  async verify(requirements: X402Accepted, payload: PaymentPayload): Promise<VerifyResult> {
    try {
      const r = await this.post<{ isValid?: boolean; valid?: boolean; payer?: string; invalidReason?: string }>(
        '/verify',
        { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: requirements },
      );
      const valid = r.isValid ?? r.valid ?? false;
      return { valid, payer: r.payer, reason: valid ? undefined : (r.invalidReason ?? 'verification failed') };
    } catch (err) {
      safeLog.error('t54 verify error', { message: (err as Error).message });
      return { valid: false, reason: (err as Error).message };
    }
  }

  async settle(requirements: X402Accepted, payload: PaymentPayload): Promise<SettlementResponse> {
    try {
      const r = await this.post<{ success?: boolean; transaction?: string; txHash?: string; payer?: string; network?: string; errorReason?: string }>(
        '/settle',
        { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: requirements },
      );
      return {
        success: r.success ?? false,
        txHash: r.txHash ?? r.transaction,
        payer: r.payer,
        network: r.network ?? requirements.network,
        errorReason: r.errorReason,
      };
    } catch (err) {
      return { success: false, network: requirements.network, errorReason: (err as Error).message };
    }
  }
}
