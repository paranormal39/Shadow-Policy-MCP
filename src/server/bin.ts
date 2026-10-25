#!/usr/bin/env node
/**
 * Entry point. Transport is chosen by --http / --stdio flags or the TRANSPORT
 * env var (default stdio).
 */
import { createServer } from './index.js';
import { startHttp, startStdio } from './transports.js';
import { ConfigError } from '../config/index.js';
import { safeLog } from '../security/secrets.js';

async function main() {
  const argv = process.argv.slice(2);
  const wantHttp = argv.includes('--http');
  const wantStdio = argv.includes('--stdio');

  let created;
  try {
    created = createServer();
  } catch (err) {
    if (err instanceof ConfigError) {
      safeLog.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const { server, ctx } = created;

  const useHttp = wantHttp || (!wantStdio && ctx.config.transport === 'http');
  safeLog.info('starting shadow-policy-mcp', {
    network: ctx.config.network,
    facilitator: ctx.config.facilitator,
    transport: useHttp ? 'http' : 'stdio',
  });

  if (useHttp) await startHttp(server, ctx.config);
  else await startStdio(server);
}

main().catch((err) => {
  safeLog.error('fatal', { message: (err as Error).message });
  process.exit(1);
});
