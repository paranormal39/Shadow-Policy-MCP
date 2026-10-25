#!/usr/bin/env node
/**
 * Entry point. Transport is chosen by --http / --stdio flags or the TRANSPORT
 * env var (default stdio).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext, createMcpServer } from './index.js';
import { startHttp, startStdio } from './transports.js';
import { ConfigError } from '../config/index.js';
import { safeLog } from '../security/secrets.js';
import type { ServerContext } from './context.js';

/**
 * Load the project's .env into process.env. Config (incl. SHADOWLABZ_API_KEY,
 * which drives the "Made by AI" badge) reads only process.env, and MCP clients
 * spawn this server over stdio without sourcing .env — so load it ourselves.
 * Resolved relative to this module (works from dist/ and src/, any cwd); a
 * missing file is a no-op so env-only deployments still work.
 */
function loadDotEnv() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    process.loadEnvFile(path.resolve(here, '../../.env'));
  } catch {
    /* no .env present — rely on the launcher's environment */
  }
}

async function main() {
  loadDotEnv();

  const argv = process.argv.slice(2);
  const wantHttp = argv.includes('--http');
  const wantStdio = argv.includes('--stdio');

  let ctx: ServerContext;
  try {
    ctx = buildContext();
  } catch (err) {
    if (err instanceof ConfigError) {
      safeLog.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const useHttp = wantHttp || (!wantStdio && ctx.config.transport === 'http');
  safeLog.info('starting shadow-policy-mcp', {
    network: ctx.config.network,
    facilitator: ctx.config.facilitator,
    transport: useHttp ? 'http' : 'stdio',
    agentTokens: ctx.tokens.size(),
  });

  if (useHttp) await startHttp(ctx);
  else await startStdio(createMcpServer(ctx));
}

main().catch((err) => {
  safeLog.error('fatal', { message: (err as Error).message });
  process.exit(1);
});
