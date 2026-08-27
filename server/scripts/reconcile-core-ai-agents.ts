import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyAgentReconciliationPlan,
  createCoreAiAgentAdminClient,
  dryRunAgentReconciliation,
  parseAgentReconciliationArguments,
} from "../src/services/coreAiAgentAdminClient.js";

async function main(): Promise<void> {
  const args = parseAgentReconciliationArguments(process.argv.slice(2));
  const baseUrl = process.env.CORE_AI_BASE_URL;
  const token = process.env.CORE_AI_TOKEN;
  if (!baseUrl || !token) throw new Error("CORE_AI_BASE_URL and CORE_AI_TOKEN are required in the environment");

  const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repositoryRoot = resolve(serverRoot, "..");
  const manifestRoot = resolve(serverRoot, "core-ai-agents");
  const client = createCoreAiAgentAdminClient({ baseUrl, token });

  if (args.mode === "dry-run") {
    const plan = await dryRunAgentReconciliation({
      client,
      repositoryRoot,
      manifestRoot,
      selection: args.selection,
      planPath: args.planPath,
    });
    console.log(JSON.stringify({
      mode: "dry-run",
      plan_digest: plan.digest,
      reference_id: plan.reference.id,
      actions: plan.selected.map((entry) => ({ path: entry.path, name: entry.name, action: entry.action, action_hash: entry.action_hash })),
    }));
    return;
  }

  const results = await applyAgentReconciliationPlan({
    client,
    repositoryRoot,
    manifestRoot,
    planPath: args.planPath,
    evidencePath: args.evidencePath,
  });
  console.log(JSON.stringify({ mode: "apply", results }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Agent reconciliation failed");
  process.exitCode = 1;
});
