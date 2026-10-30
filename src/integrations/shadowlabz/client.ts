/**
 * Typed HTTP client for the Shadow Labz (votechain) backend — the Shadow Polls
 * adapter. Documented in the repo's API.md. Machine access uses `x-api-key`
 * (the legacy GAME_API_KEY or an sdk_ per-client key); in dev the gate may be
 * disabled, in which case apiKey can be null.
 *
 * The API key is request-only; it is never returned to agents or logged.
 */
export interface ShadowLabzEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string; details?: unknown };
}

export interface PollQuestionInput {
  prompt: string;
  options: string[];
  type?: 'single' | 'multi' | 'stars';
}

export interface CreatePollInput {
  title: string;
  description?: string;
  kind: 'single' | 'survey';
  options?: string[];
  questions?: PollQuestionInput[];
  segments?: string[];
  eligibility?: { method: 'open' | 'qr_rotating' | 'token' | 'code' | 'discord' | 'wallet'; [k: string]: unknown };
  tags?: string[];
  deadlineSeconds?: number;
  /** Provenance: marks the poll as AI-made. Honored by votechain only for
   *  authenticated API-key callers (drives a "Made by AI" badge in the UI). */
  createdByAgent?: boolean;
}

/** Poll metadata as returned by votechain (loosely typed; we only rely on id/status). */
export interface Poll {
  id: string;
  title?: string;
  status?: string;
  kind?: string;
  [k: string]: unknown;
}

export interface CreatePollResult {
  poll: Poll;
  organizerKey: string;
}

/** Result of resolving a Legion agent bearer token via votechain. */
export interface AgentTokenIntrospection {
  active: boolean;
  /** Stable agent identifier, if votechain returns one (else walletAddress is used). */
  agentId?: string;
  /** The agent's votechain actor wallet (already enrolled in the Legion DAO). */
  walletAddress?: string;
  chain?: string;
  roles?: string[];
}

export class ShadowLabzError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) {
    super(message);
    this.name = 'ShadowLabzError';
  }
}

export interface ShadowLabzClientOptions {
  baseUrl: string;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  /** Default request timeout (ms) for ordinary reads/writes. */
  timeoutMs?: number;
  /** Timeout (ms) for on-chain ops (create/activate) which run a ZK proof and can take minutes. */
  longTimeoutMs?: number;
}

export class ShadowLabzClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly longTimeoutMs: number;

  constructor(opts: ShadowLabzClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.longTimeoutMs = opts.longTimeoutMs ?? 180_000;
  }

  private async request<T>(path: string, init: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers['x-api-key'] = this.apiKey;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      throw new ShadowLabzError(`Network error reaching Shadow Labz: ${(err as Error).message}`, 0, 'NETWORK_ERROR');
    }

    const text = await res.text();
    let parsed: ShadowLabzEnvelope<T> | undefined;
    try {
      parsed = text ? (JSON.parse(text) as ShadowLabzEnvelope<T>) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!res.ok || (parsed && parsed.success === false)) {
      throw new ShadowLabzError(
        parsed?.error?.message ?? `HTTP ${res.status} on ${path}`,
        res.status,
        parsed?.error?.code,
        parsed?.error?.details,
      );
    }
    return (parsed && 'data' in parsed ? parsed.data : (parsed as unknown)) as T;
  }

  /**
   * Resolve a Legion agent bearer token (an `agt_…` string issued from the
   * votechain dashboard) to its bound identity. Returns `{ active: false }` for
   * an unknown/revoked *agent token* (HTTP 404). Requires the server's
   * `x-api-key`.
   *
   * A 401/403 here is about the SERVER's own `x-api-key`, not the agent token —
   * we deliberately let it throw so a misconfigured `SHADOWLABZ_API_KEY` surfaces
   * as a loud server error instead of silently rejecting every agent as if their
   * token were bad.
   */
  async introspectAgentToken(token: string): Promise<AgentTokenIntrospection> {
    try {
      return await this.request<AgentTokenIntrospection>('/api/agent-tokens/introspect', { method: 'POST', body: { token } });
    } catch (err) {
      if (err instanceof ShadowLabzError && err.status === 404) return { active: false };
      if (err instanceof ShadowLabzError && (err.status === 401 || err.status === 403)) {
        throw new ShadowLabzError(
          `Agent-token introspection was rejected by votechain (HTTP ${err.status}: ${err.message}). This is the SERVER's SHADOWLABZ_API_KEY being invalid — not the agent's token. Set a valid x-api-key.`,
          err.status,
          err.code,
        );
      }
      throw err;
    }
  }

  createPoll(input: CreatePollInput): Promise<CreatePollResult> {
    // On-chain mode mirrors the poll to the Shadow Polls contract (ZK proof).
    return this.request<CreatePollResult>('/api/polls', { method: 'POST', body: input, timeoutMs: this.longTimeoutMs });
  }

  getPoll(id: string): Promise<Poll> {
    return this.request<Poll>(`/api/polls/${encodeURIComponent(id)}`);
  }

  /** Publish a draft poll (draft -> active). Requires the one-time organizer key.
   *  On-chain activation runs a ZK proof and can take minutes, so it uses the long timeout. */
  activatePoll(id: string, organizerKey: string): Promise<unknown> {
    return this.request(`/api/polls/${encodeURIComponent(id)}/activate`, { method: 'POST', body: { organizerKey }, timeoutMs: this.longTimeoutMs });
  }

  listPolls(): Promise<Poll[]> {
    return this.request<Poll[]>('/api/polls');
  }

  submitVote(id: string, body: { answers: number[][]; segment?: number; deviceId?: string }): Promise<unknown> {
    return this.request(`/api/polls/${encodeURIComponent(id)}/vote`, { method: 'POST', body });
  }

  // ── DAOs / governance (Phase 3) ──────────────────────────────────────────
  listDaos(all = true): Promise<unknown[]> {
    return this.request<unknown[]>(`/api/orgs${all ? '?all=1' : ''}`);
  }

  getDao(id: string): Promise<unknown> {
    return this.request(`/api/orgs/${encodeURIComponent(id)}`);
  }

  listDaoMembers(id: string): Promise<unknown[]> {
    return this.request<unknown[]>(`/api/orgs/${encodeURIComponent(id)}/members`);
  }

  joinDao(id: string, body: { walletAddress: string; chain: string; displayName?: string; proofHash?: string }): Promise<unknown> {
    return this.request(`/api/orgs/${encodeURIComponent(id)}/join`, { method: 'POST', body });
  }

  /** Update a DAO's membership/profile settings (admin). Used to set the join
   *  policy to invite-only. */
  updateDao(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/orgs/${encodeURIComponent(id)}`, { method: 'PATCH', body });
  }

  /** Directly enrol a member (the API-key integration path on POST
   *  /api/orgs/{id}/members). For an invite-only DAO this is how the server
   *  admits an agent by its wallet. */
  addDaoMember(id: string, body: { walletAddress: string; chain: string; displayName?: string; role?: 'admin' | 'member' | 'observer' }): Promise<unknown> {
    return this.request(`/api/orgs/${encodeURIComponent(id)}/members`, { method: 'POST', body });
  }

  /** DAOs are created via the launchpad: POST /api/projects (org activates later). */
  createProject(body: Record<string, unknown>): Promise<unknown> {
    return this.request('/api/projects', { method: 'POST', body });
  }

  listProposals(orgId: string): Promise<unknown[]> {
    return this.request<unknown[]>(`/api/orgs/${encodeURIComponent(orgId)}/proposals`);
  }

  createProposal(orgId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/orgs/${encodeURIComponent(orgId)}/proposals`, { method: 'POST', body });
  }

  getProposal(pid: string): Promise<unknown> {
    return this.request(`/api/proposals/${encodeURIComponent(pid)}`);
  }

  voteProposal(pid: string, body: { walletAddress: string; choice: 'yes' | 'no' | 'abstain' }): Promise<unknown> {
    return this.request(`/api/proposals/${encodeURIComponent(pid)}/vote`, { method: 'POST', body });
  }

  proposalStatus(pid: string, body: { action: 'activate' | 'finalize' }): Promise<unknown> {
    return this.request(`/api/proposals/${encodeURIComponent(pid)}/status`, { method: 'POST', body });
  }

  // ── Treasury (Phase 4) ───────────────────────────────────────────────────
  getTreasury(orgId: string): Promise<unknown> {
    return this.request(`/api/orgs/${encodeURIComponent(orgId)}/treasury`);
  }

  createSpendRequest(
    orgId: string,
    body: { amount: string | number; currency?: string; recipientAddress: string; purpose: string; requestedBy: string; proposalId?: string; privacyMode?: 'public' | 'hybrid' | 'private' },
  ): Promise<unknown> {
    return this.request(`/api/orgs/${encodeURIComponent(orgId)}/treasury/spend`, { method: 'POST', body });
  }

  executeSpend(orgId: string, body: { spendRequestId: string; authorisedBy: string; txHash?: string }): Promise<unknown> {
    return this.request(`/api/orgs/${encodeURIComponent(orgId)}/treasury/spend?action=execute`, { method: 'POST', body });
  }
}
