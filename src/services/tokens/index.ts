/**
 * Token registry — maps an HTTP bearer token to a FIXED agent identity.
 *
 * This is what makes the shared endpoint safe for many agents: the caller's
 * `agentId` is derived from their authenticated token, not trusted from the
 * request body, so one agent can't spend against or read another's identity.
 *
 * Tokens are loaded from (a) the AGENT_TOKENS env var (`token:agentId[:label]`,
 * comma-separated) and (b) a JSON file issued via the tokens CLI. Only the
 * SHA-256 hash of each token is kept in memory.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface TokenIdentity {
  agentId: string;
  label?: string;
  roles: string[];
  /** The agent's votechain actor wallet (governance/membership/treasury). */
  walletAddress?: string;
  /** Chain the walletAddress belongs to (midnight | xrpl | xahau | cardano). */
  chain?: string;
}

export interface TokenFileRecord {
  id: string;
  hash: string; // sha256(token) hex
  agentId: string;
  label?: string;
  roles?: string[];
  walletAddress?: string;
  chain?: string;
  revoked?: boolean;
  createdAt?: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token.trim(), 'utf8').digest('hex');
}

export class TokenRegistry {
  private readonly byHash = new Map<string, TokenIdentity>();

  add(token: string, identity: TokenIdentity): void {
    this.byHash.set(hashToken(token), identity);
  }

  addHash(hash: string, identity: TokenIdentity): void {
    this.byHash.set(hash, identity);
  }

  size(): number {
    return this.byHash.size;
  }

  /** Resolve a bearer token to its bound identity, or null. Constant-time per entry. */
  resolve(bearer: string): TokenIdentity | null {
    const incoming = Buffer.from(hashToken(bearer), 'hex');
    for (const [hash, identity] of this.byHash) {
      const stored = Buffer.from(hash, 'hex');
      if (stored.length === incoming.length && timingSafeEqual(stored, incoming)) return identity;
    }
    return null;
  }

  static load(opts: { envTokens?: string; file?: string } = {}): TokenRegistry {
    const reg = new TokenRegistry();

    // env: AGENT_TOKENS="tok1:agentA,tok2:agentB:Bob"
    if (opts.envTokens) {
      for (const entry of opts.envTokens.split(',').map((s) => s.trim()).filter(Boolean)) {
        const [token, agentId, label] = entry.split(':');
        if (token && agentId) reg.add(token, { agentId, label, roles: [] });
      }
    }

    // file: .data/agent-tokens.json (hashes only)
    if (opts.file) {
      try {
        const data = JSON.parse(readFileSync(opts.file, 'utf8')) as { tokens?: TokenFileRecord[] };
        for (const t of data.tokens ?? []) {
          if (!t.revoked && t.hash && t.agentId) reg.addHash(t.hash, { agentId: t.agentId, label: t.label, roles: t.roles ?? [], walletAddress: t.walletAddress, chain: t.chain });
        }
      } catch {
        /* no file yet — fine */
      }
    }

    return reg;
  }
}

export { hashToken };
