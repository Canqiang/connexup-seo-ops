import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendReconciliationEvidence,
  createCoreAiAgentAdminClient,
  discoverEditableReference,
  reconcileAgents,
  type AgentManifest,
} from "../src/services/coreAiAgentAdminClient.js";

type Mode = "dry-run" | "apply";

function parseArguments(argv: string[]): { mode: Mode; evidencePath?: string } {
  let mode: Mode | undefined;
  let evidencePath: string | undefined;
  for (const argument of argv) {
    if (argument.startsWith("--mode=")) {
      const value = argument.slice("--mode=".length);
      if (value !== "dry-run" && value !== "apply") throw new Error("--mode must be dry-run or apply");
      mode = value;
      continue;
    }
    if (argument.startsWith("--evidence=")) {
      evidencePath = argument.slice("--evidence=".length);
      continue;
    }
    if (/token|authorization|cookie|secret/i.test(argument)) {
      throw new Error("Credentials are accepted only through CORE_AI_TOKEN");
    }
    throw new Error(`Unknown argument: ${argument.split("=")[0]}`);
  }
  if (mode === undefined) throw new Error("--mode=dry-run or --mode=apply is required");
  if (mode === "apply" && (evidencePath === undefined || !isAbsolute(evidencePath))) {
    throw new Error("Apply mode requires --evidence=<absolute-path>");
  }
  if (mode === "dry-run" && evidencePath !== undefined) {
    throw new Error("--evidence is accepted only in apply mode");
  }
  return { mode, ...(evidencePath === undefined ? {} : { evidencePath }) };
}

async function loadManifests(directory: string): Promise<AgentManifest[]> {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".json") && file !== "manifest.schema.json")
    .sort();
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(resolve(directory, file), "utf8")) as AgentManifest));
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const baseUrl = process.env.CORE_AI_BASE_URL;
  const token = process.env.CORE_AI_TOKEN;
  if (!baseUrl || !token) throw new Error("CORE_AI_BASE_URL and CORE_AI_TOKEN are required in the environment");

  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const serverRoot = resolve(scriptDirectory, "..");
  const repositoryRoot = resolve(serverRoot, "..");
  const manifests = await loadManifests(resolve(serverRoot, "core-ai-agents"));
  const client = createCoreAiAgentAdminClient({ baseUrl, token });
  const reference = await discoverEditableReference({ client });
  console.log(JSON.stringify({ reference }));
  const results = await reconcileAgents({
    client,
    manifests,
    mode: args.mode,
    referenceAgentId: reference.id,
    logger: console.log,
  });
  if (args.mode === "apply" && args.evidencePath !== undefined) {
    await appendReconciliationEvidence({
      repositoryRoot,
      evidencePath: args.evidencePath,
      records: [{ reference }, ...results],
    });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Agent reconciliation failed";
  console.error(message);
  process.exitCode = 1;
});
