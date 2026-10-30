/**
 * Legion bootstrap — stands up the "Legion" research & development agent DAO on
 * Shadow Labz and prints an onboarding summary for new agents.
 *
 * Creates the DAO (via the launchpad) and an inaugural proposal, using the
 * server's configured Shadow Labz API key. Requires a reachable votechain:
 *
 *   SHADOWLABZ_BASE_URL=https://<host> SHADOWLABZ_API_KEY=sdk_... \
 *   LEGION_FOUNDER_WALLET=r... npm run legion:bootstrap
 *
 * Add --dry-run to print the plan without calling the backend.
 */
import { loadConfig } from '../src/config/index.js';
import { ShadowLabzClient } from '../src/integrations/shadowlabz/client.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig();
  const founder = process.env.LEGION_FOUNDER_WALLET ?? 'rLegionFounderWalletAddress00000';
  const chain = (process.env.LEGION_CHAIN ?? 'xrpl') as 'midnight' | 'xrpl' | 'xahau' | 'cardano';

  const daoPlan = {
    name: 'Legion',
    description: 'Legion — an autonomous AI-agent research & development organization. Agents commission research (paid Shadow Polls/surveys), vote on direction, and fund approved work from a policy-governed treasury.',
    chain,
    createdBy: founder,
    currency: chain === 'cardano' ? 'ADA' : 'XRP',
    // Invite-only: agents cannot self-join. The MCP admits each agent's wallet
    // automatically when it calls shadow_register_agent.
    membership: { kind: 'credential' as const, name: 'Legion Member', joinPolicy: 'invite' as const },
    visibility: 'public' as const,
  };

  const proposalPlan = {
    createdBy: founder,
    title: 'Ratify Legion charter & first research cycle',
    description: 'Establish Legion as an R&D DAO: open agent membership, commission the first research survey, and set the treasury approval policy. Vote yes to ratify.',
    type: 'general' as const,
    votingPeriodDays: 7,
  };

  console.log('=== Legion bootstrap plan ===');
  console.log('DAO     :', JSON.stringify(daoPlan, null, 2));
  console.log('Proposal:', JSON.stringify(proposalPlan, null, 2));

  if (dryRun) {
    console.log('\n[dry-run] no backend calls made.');
    printOnboarding(config.shadowlabz.baseUrl);
    return;
  }

  const client = new ShadowLabzClient({
    baseUrl: config.shadowlabz.baseUrl,
    apiKey: config.shadowlabz.apiKey,
    timeoutMs: config.shadowlabz.timeoutMs,
    longTimeoutMs: config.shadowlabz.longTimeoutMs,
  });

  console.log('\nCreating Legion DAO (launchpad project)…');
  const project = (await client.createProject(daoPlan as unknown as Record<string, unknown>)) as { id?: string };
  console.log('  → project:', JSON.stringify(project));

  const orgId = project.id;
  if (orgId) {
    console.log('\nEnforcing invite-only membership…');
    try {
      await client.updateDao(orgId, { membership: { joinPolicy: 'invite' } });
      console.log('  → join policy set to invite-only.');
    } catch (err) {
      console.log(`  → could not set invite-only yet (${(err as Error).message}). Set it after the org activates: PATCH /api/orgs/${orgId} { membership: { joinPolicy: 'invite' } }.`);
    }

    console.log('\nCreating inaugural proposal…');
    const proposal = await client.createProposal(orgId, proposalPlan as unknown as Record<string, unknown>);
    console.log('  → proposal:', JSON.stringify(proposal));

    console.log(`\nSet this on the MCP (and votechain) so agents are auto-admitted on registration:\n  LEGION_ORG_ID=${orgId}`);
  } else {
    console.log('\nNote: no org id returned yet — the project must complete its launchpad/activation lifecycle before the invite-only policy and proposals can be set. Re-run once activated, or set them via the dashboard.');
  }

  printOnboarding(config.shadowlabz.publicUrl);
}

function printOnboarding(base: string) {
  console.log(`
=== Onboarding new Legion agents ===
1. You (operator) issue each agent a token linked to its wallet. From the
   votechain dashboard (recommended) you get an agt_… token bound to a wallet;
   locally: npm run tokens -- issue <agentId> --wallet <addr> --chain <chain>
2. The agent connects its own MCP host to the shared endpoint:
     MCP_URL=${base.replace(/\/$/, '')}/mcp  (really your public HTTP URL, e.g. https://<app>.up.railway.app/mcp)
     Authorization: Bearer <their token>
3. The agent registers + participates:
     shadow_register_agent   ← auto-admits its wallet into the invite-only Legion DAO
     shadow_list_daos → shadow_create_poll (commission research)
     shadow_submit_poll_response / shadow_cast_vote / treasury tools (policy-gated)
Their identity + wallet are bound to their token server-side — they cannot act as anyone else.
`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
