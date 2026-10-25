/**
 * Poll analytics (Phase 2). Computes privacy-preserving aggregate analytics
 * from a Shadow Labz poll's public tallies — never per-voter data. Defensive
 * about the backend shape (single polls expose `tallies: number[]` + `options`;
 * surveys expose `questionTallies: number[][]`).
 */
import type { Poll } from '../../integrations/shadowlabz/client.js';
import type { ProvenanceSummary } from '../provenance/index.js';

export interface OptionBreakdown {
  index: number;
  label?: string;
  count: number;
  percent: number;
}

export interface PollAnalytics {
  pollId: string;
  status?: string;
  totalVotes: number;
  options: OptionBreakdown[];
  questions?: Array<{ prompt?: string; options: OptionBreakdown[] }>;
  provenance: ProvenanceSummary;
}

function breakdown(tallies: number[], labels?: string[]): { total: number; options: OptionBreakdown[] } {
  const total = tallies.reduce((a, b) => a + (Number(b) || 0), 0);
  const options = tallies.map((count, index) => ({
    index,
    label: labels?.[index],
    count: Number(count) || 0,
    percent: total > 0 ? Math.round(((Number(count) || 0) / total) * 1000) / 10 : 0,
  }));
  return { total, options };
}

export function computeAnalytics(poll: Poll, provenance: ProvenanceSummary): PollAnalytics {
  const p = poll as Poll & {
    tallies?: number[];
    questionTallies?: number[][];
    totalVotes?: number;
    options?: string[];
    questions?: Array<{ prompt?: string; options?: string[] }>;
  };

  const single = breakdown(Array.isArray(p.tallies) ? p.tallies : [], p.options);
  const questions = Array.isArray(p.questionTallies)
    ? p.questionTallies.map((qt, qi) => ({ prompt: p.questions?.[qi]?.prompt, options: breakdown(qt, p.questions?.[qi]?.options).options }))
    : undefined;

  return {
    pollId: poll.id,
    status: poll.status,
    totalVotes: typeof p.totalVotes === 'number' ? p.totalVotes : single.total,
    options: single.options,
    questions: questions && questions.length ? questions : undefined,
    provenance,
  };
}
