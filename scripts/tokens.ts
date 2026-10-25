/**
 * Agent token CLI — issue / list / revoke bearer tokens that bind an HTTP
 * caller to a fixed agentId. Tokens are stored as SHA-256 hashes in
 * .data/agent-tokens.json; the plaintext is shown ONCE at issue time.
 *
 *   npm run tokens -- issue <agentId> [--label "Alice's bot"] [--role respondent]
 *   npm run tokens -- list
 *   npm run tokens -- revoke <tokenId>
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hashToken, type TokenFileRecord } from '../src/services/tokens/index.js';

const FILE = resolve(process.cwd(), '.data/agent-tokens.json');

function readFile(): { tokens: TokenFileRecord[] } {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return { tokens: [] };
  }
}

function writeFile(data: { tokens: TokenFileRecord[] }): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const data = readFile();

  if (cmd === 'issue') {
    const agentId = rest.find((a) => !a.startsWith('--'));
    if (!agentId) throw new Error('Usage: tokens issue <agentId> [--label ..] [--role ..]');
    const id = randomBytes(6).toString('hex');
    const secret = randomBytes(24).toString('base64url');
    const token = `lgn_${id}.${secret}`;
    const record: TokenFileRecord = {
      id,
      hash: hashToken(token),
      agentId,
      label: getFlag(rest, 'label'),
      roles: getFlag(rest, 'role') ? [getFlag(rest, 'role')!] : [],
      revoked: false,
      createdAt: new Date().toISOString(),
    };
    data.tokens.push(record);
    writeFile(data);
    console.log(`\nIssued token for agentId="${agentId}" (id ${id})\n`);
    console.log(`  ${token}\n`);
    console.log('Copy it now — only its hash is stored, it cannot be shown again.');
    console.log('The holder connects with:  Authorization: Bearer <token>');
    return;
  }

  if (cmd === 'list') {
    if (data.tokens.length === 0) return void console.log('No tokens issued.');
    for (const t of data.tokens) console.log(`${t.id}  agentId=${t.agentId}  ${t.revoked ? '[REVOKED]' : 'active'}  ${t.label ?? ''}`);
    return;
  }

  if (cmd === 'revoke') {
    const id = rest[0];
    const t = data.tokens.find((x) => x.id === id);
    if (!t) throw new Error(`No token with id ${id}`);
    t.revoked = true;
    writeFile(data);
    console.log(`Revoked token ${id} (agentId=${t.agentId}).`);
    return;
  }

  console.log('Usage: tokens <issue|list|revoke> ...');
  process.exit(1);
}

main();
