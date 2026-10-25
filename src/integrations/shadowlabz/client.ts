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
}

export class ShadowLabzClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ShadowLabzClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers['x-api-key'] = this.apiKey;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(20_000),
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

  createPoll(input: CreatePollInput): Promise<CreatePollResult> {
    return this.request<CreatePollResult>('/api/polls', { method: 'POST', body: input });
  }

  getPoll(id: string): Promise<Poll> {
    return this.request<Poll>(`/api/polls/${encodeURIComponent(id)}`);
  }

  /** Publish a draft poll (draft -> active). Requires the one-time organizer key. */
  activatePoll(id: string, organizerKey: string): Promise<unknown> {
    return this.request(`/api/polls/${encodeURIComponent(id)}/activate`, { method: 'POST', body: { organizerKey } });
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
