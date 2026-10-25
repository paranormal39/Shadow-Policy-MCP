/**
 * LLM ↔ MCP agent bridge.
 *
 * Spawns the Shadow Policy MCP server over stdio, exposes its tools to an LLM,
 * and runs the tool-calling loop so the model can discover → quote → authorize
 * → pay → create a poll on its own.
 *
 * Providers (no extra npm deps — all via fetch):
 *   PROVIDER=anthropic   ANTHROPIC_API_KEY=...   [MODEL=claude-3-5-sonnet-latest]
 *   PROVIDER=openai      OPENAI_API_KEY=...       [MODEL=gpt-4o-mini]
 *   PROVIDER=ollama      (local, no key)          [MODEL=llama3.1  OLLAMA_URL=http://localhost:11434]
 *
 * Usage:
 *   npm run build
 *   PROVIDER=ollama MODEL=llama3.1 npm run agent -- "Create a poll asking devs their favourite chain"
 *
 * Any SHADOWLABZ_* / FACILITATOR / XRPL_NETWORK env vars are forwarded to the
 * spawned server, so this works against the mock flow or a live votechain.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, '../../dist/server/bin.js');

const AGENT_ID = 'llm-agent-1';
const SYSTEM = `You are an autonomous agent with access to the Shadow Policy MCP tools for buying and creating Shadow Polls, paid for with XRPL x402.

Always follow this exact sequence to create a poll:
1. shadow_prepare_poll  (agentId="${AGENT_ID}", pass a pollDraft). Keep the returned "quote" object.
2. shadow_request_payment_authorization (agentId, quote).
3. shadow_execute_payment (agentId, quote, simulate=true). (simulate=true works because the server uses the mock facilitator.)
4. shadow_create_poll (agentId, invoiceId from the quote, poll = the same draft).
Then report the returned pollUrl to the user. Pass objects (like "quote") back verbatim. Use agentId="${AGENT_ID}" everywhere.

Rules:
- ALWAYS respond by actually calling a tool (emit a tool call) until you have the final pollUrl. Never write code blocks or prose that merely describes a call.
- For a simple single-choice poll, send only: title, kind="single", options (2-8 strings), description, eligibility={method:"open"}. Do NOT include questions or segments.
- Step 4 (shadow_create_poll) is MANDATORY — a poll is NOT created by paying. You must call it after payment.
- The pollUrl is ONLY the "pollUrl" field returned by shadow_create_poll. NEVER invent, guess, or write any other URL. If you have not yet called shadow_create_poll, call it now instead of answering.
- Only write a normal text message after shadow_create_poll returns, and quote its pollUrl exactly.`;

type ToolCall = { id: string; name: string; args: Record<string, unknown> };
type McpTool = { name: string; description?: string; inputSchema: unknown };

interface Provider {
  initHistory(user: string): void;
  send(tools: McpTool[]): Promise<{ text: string; toolCalls: ToolCall[] }>;
  pushToolResults(results: Array<{ id: string; name: string; content: string }>): void;
  pushUser(text: string): void;
}

// ── Anthropic ────────────────────────────────────────────────────────────────
class AnthropicProvider implements Provider {
  private messages: unknown[] = [];
  private lastAssistant: unknown;
  constructor(private key: string, private model: string) {}
  initHistory(user: string) {
    this.messages = [{ role: 'user', content: user }];
  }
  async send(tools: McpTool[]) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        messages: this.messages,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> };
    this.lastAssistant = { role: 'assistant', content: data.content };
    this.messages.push(this.lastAssistant);
    const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const toolCalls = data.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id!, name: b.name!, args: (b.input ?? {}) as Record<string, unknown> }));
    return { text, toolCalls };
  }
  pushToolResults(results: Array<{ id: string; name: string; content: string }>) {
    this.messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })) });
  }
  pushUser(text: string) {
    this.messages.push({ role: 'user', content: text });
  }
}

// ── OpenAI (chat completions) ────────────────────────────────────────────────
class OpenAIProvider implements Provider {
  private messages: unknown[] = [];
  constructor(private key: string, private model: string, private baseUrl = 'https://api.openai.com/v1') {}
  initHistory(user: string) {
    this.messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
  }
  async send(tools: McpTool[]) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        model: this.model,
        messages: this.messages,
        tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices: Array<{ message: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
    const msg = data.choices[0].message;
    this.messages.push(msg);
    const toolCalls = (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, args: safeJson(c.function.arguments) }));
    return { text: msg.content ?? '', toolCalls };
  }
  pushToolResults(results: Array<{ id: string; name: string; content: string }>) {
    for (const r of results) this.messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
  }
  pushUser(text: string) {
    this.messages.push({ role: 'user', content: text });
  }
}

// ── Ollama (local, /api/chat) ────────────────────────────────────────────────
class OllamaProvider implements Provider {
  private messages: unknown[] = [];
  constructor(private model: string, private baseUrl = 'http://localhost:11434') {}
  initHistory(user: string) {
    this.messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
  }
  async send(tools: McpTool[]) {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        options: { temperature: 0 },
        messages: this.messages,
        tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { message: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> } };
    if (process.env.DEBUG_BRIDGE) process.stderr.write(`[ollama raw] tc=${data.message.tool_calls?.length ?? 0} content=${JSON.stringify(data.message.content)?.slice(0, 400)}\n`);
    this.messages.push(data.message);
    const toolCalls = (data.message.tool_calls ?? []).map((c, i) => ({ id: `call_${i}`, name: c.function.name, args: c.function.arguments ?? {} }));
    return { text: data.message.content ?? '', toolCalls };
  }
  pushToolResults(results: Array<{ id: string; name: string; content: string }>) {
    for (const r of results) this.messages.push({ role: 'tool', content: r.content });
  }
  pushUser(text: string) {
    this.messages.push({ role: 'user', content: text });
  }
}

/**
 * Small models (esp. llama3.1 via Ollama) sometimes emit a tool call as inline
 * JSON text instead of a structured tool_calls field. Recover it: find a JSON
 * object whose "name" matches a known tool and read its params.
 */
function repairJson(t: string): string {
  // Append any missing closing quotes/brackets/braces (small models often
  // truncate the trailing closers). Braces inside strings are ignored.
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of t) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = t;
  if (inStr) out += '"';
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
  return out;
}

function salvageToolCalls(text: string, toolNames: Set<string>): ToolCall[] {
  if (!text) return [];
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  const candidates: string[] = [t, repairJson(t)];
  // also extract the first balanced {...} block
  const start = t.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < t.length; i++) {
      if (t[i] === '{') depth++;
      else if (t[i] === '}' && --depth === 0) {
        candidates.push(t.slice(start, i + 1));
        break;
      }
    }
  }
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Record<string, unknown>;
      const name = obj.name as string | undefined;
      if (name && toolNames.has(name)) {
        const args = (obj.parameters ?? obj.arguments ?? obj.input ?? {}) as Record<string, unknown>;
        return [{ id: 'salvaged_0', name, args }];
      }
    } catch {
      /* try next candidate */
    }
  }
  return [];
}

/** Lenient parse: JSON first, then Python-dict-ish (single quotes, True/False/None). */
function looseParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  try {
    const j = s.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null').replace(/'/g, '"');
    return JSON.parse(repairJson(j));
  } catch {
    return undefined;
  }
}

/**
 * Small models often stringify nested object/array arguments. Coerce any
 * top-level string value that looks like a JSON object/array back into a value.
 */
function coerceArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        const parsed = looseParse(t);
        out[k] = parsed !== undefined ? parsed : v;
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function makeProvider(): Provider {
  const provider = (process.env.PROVIDER ?? 'anthropic').toLowerCase();
  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY.');
    return new AnthropicProvider(process.env.ANTHROPIC_API_KEY, process.env.MODEL ?? 'claude-3-5-sonnet-latest');
  }
  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY.');
    return new OpenAIProvider(process.env.OPENAI_API_KEY, process.env.MODEL ?? 'gpt-4o-mini');
  }
  if (provider === 'ollama') {
    return new OllamaProvider(process.env.MODEL ?? 'llama3.1', process.env.OLLAMA_URL ?? 'http://localhost:11434');
  }
  throw new Error(`Unknown PROVIDER "${provider}" (use anthropic | openai | ollama).`);
}

async function main() {
  const userPrompt = process.argv.slice(2).join(' ') || 'Create a poll asking developers which blockchain they prefer, then give me the poll URL.';
  const provider = makeProvider();

  const transport = new StdioClientTransport({ command: 'node', args: [SERVER_ENTRY, '--stdio'], env: process.env as Record<string, string> });
  const client = new Client({ name: 'llm-agent-bridge', version: '0.1.0' });
  await client.connect(transport);

  const all = (await client.listTools()) as { tools: McpTool[] };
  // Optional: narrow the toolset shown to the model (helps smaller models focus).
  // ALLOW_TOOLS=shadow_prepare_poll,shadow_request_payment_authorization,shadow_execute_payment,shadow_create_poll
  const allow = (process.env.ALLOW_TOOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const tools = allow.length ? all.tools.filter((t) => allow.includes(t.name)) : all.tools;
  const toolNames = new Set(tools.map((t) => t.name));
  console.log(`[bridge] connected. ${all.tools.length} tools available${allow.length ? `, ${tools.length} exposed to the model` : ''}. provider=${process.env.PROVIDER ?? 'anthropic'}\n`);

  provider.initHistory(userPrompt);
  console.log(`USER: ${userPrompt}\n`);

  let nudges = 0;
  const MAX_NUDGES = 1;
  for (let turn = 0; turn < 14; turn++) {
    const { text, toolCalls } = await provider.send(tools);
    let calls = toolCalls;
    if (calls.length === 0) {
      const salvaged = salvageToolCalls(text, toolNames);
      if (salvaged.length) {
        console.log(`[bridge] recovered a tool call from text content`);
        calls = salvaged;
      }
    }
    if (calls.length === 0) {
      // Optional reflection nudge (REFLECT=1). Weaker models sometimes "declare
      // done" early; this reminds them to finish the CURRENT task via tools and
      // never fabricate a result. Off by default — capable models don't need it,
      // and very weak models tend to restart instead of continue.
      if (process.env.REFLECT && nudges < MAX_NUDGES) {
        nudges++;
        console.log(`[bridge] nudging the model to finish via tools (${nudges}/${MAX_NUDGES})`);
        provider.pushUser(
          'If you have already paid an invoice but have not yet received a pollUrl from shadow_create_poll, call shadow_create_poll now with THAT SAME invoiceId. Do NOT start a new poll or call shadow_prepare_poll again. NEVER state a URL you did not receive from a tool.',
        );
        continue;
      }
      if (text) console.log(`ASSISTANT: ${text}\n`);
      break;
    }

    const results: Array<{ id: string; name: string; content: string }> = [];
    for (const call of calls) {
      const callArgs = coerceArgs(call.args);
      console.log(`→ tool: ${call.name}(${JSON.stringify(callArgs)})`);
      try {
        const res = (await client.callTool({ name: call.name, arguments: callArgs })) as { content: Array<{ type: string; text?: string }> };
        const content = res.content.find((c) => c.type === 'text')?.text ?? '';
        console.log(`  ↳ ${content.slice(0, 300)}${content.length > 300 ? '…' : ''}\n`);
        results.push({ id: call.id, name: call.name, content });
      } catch (err) {
        const content = `ERROR: ${(err as Error).message}`;
        console.log(`  ↳ ${content}\n`);
        results.push({ id: call.id, name: call.name, content });
      }
    }
    provider.pushToolResults(results);
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
