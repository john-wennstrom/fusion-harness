/**
 * cli.ts — headless fusion harness. Read-only protocols only.
 *
 *   bun run harness/cli.ts opinion "prompt"
 *   bun run harness/cli.ts debate --rounds 3 "prompt"
 *   bun run harness/cli.ts stack
 */

import * as path from "node:path";
import { describeStack, loadStack, runDebate, runOpinion, toMarkdown, type DebateResult, type OpinionResult } from "./core.ts";

const DEFAULT_CONFIG = path.join(".pi", "fusion-harness", "model-stack-copilot.yaml");

const USAGE = `fusion-harness (headless)

  opinion <prompt>            every configured slot answers independently, read-only
  debate  <prompt>            N-way all-to-all debate, no judge
  stack                       show the configured slots

Options
  --config <path>             stack YAML (default ${DEFAULT_CONFIG})
  --rounds <n>                debate rounds, 2-10 (default 3)
  --cwd <path>                directory the read-only agents inspect (default cwd)
  --timeout <seconds>         per-child timeout (default 600)
  --json                      emit the raw result object instead of markdown
`;

function parseArgs(argv: string[]) {
	const flags: Record<string, string> = {};
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") flags.json = "true";
		else if (arg.startsWith("--")) flags[arg.slice(2)] = argv[++i] ?? "";
		else rest.push(arg);
	}
	return { flags, rest };
}

async function main(): Promise<number> {
	const { flags, rest } = parseArgs(process.argv.slice(2));
	const command = rest.shift();
	if (!command || command === "help" || flags.help) {
		process.stdout.write(USAGE);
		return command ? 0 : 1;
	}

	const configPath = path.resolve(flags.config ?? DEFAULT_CONFIG);
	if (command === "stack") {
		process.stdout.write(`${describeStack(loadStack(configPath))}\n`);
		return 0;
	}

	const prompt = rest.join(" ").trim();
	if (!prompt) {
		process.stderr.write(`fusion-harness: ${command} needs a prompt\n\n${USAGE}`);
		return 1;
	}

	const numeric = (raw: string | undefined, label: string): number | undefined => {
		if (raw === undefined) return undefined;
		const value = Number(raw);
		if (!Number.isFinite(value) || value <= 0) throw new Error(`--${label} must be a positive number, got ${JSON.stringify(raw)}`);
		return value;
	};

	const shared = {
		configPath,
		prompt,
		cwd: path.resolve(flags.cwd ?? process.cwd()),
		timeoutMs: (numeric(flags.timeout, "timeout") ?? 0) * 1000 || undefined,
	};

	let result: OpinionResult | DebateResult;
	if (command === "opinion") result = await runOpinion(shared);
	else if (command === "debate") result = await runDebate({ ...shared, rounds: numeric(flags.rounds, "rounds") });
	else {
		process.stderr.write(`fusion-harness: unknown command "${command}"\n\n${USAGE}`);
		return 1;
	}

	process.stdout.write(flags.json ? `${JSON.stringify(result, null, 2)}\n` : `${toMarkdown(result)}\n`);
	return result.ok ? 0 : 2;
}

main().then(
	(code) => process.exit(code),
	(error) => {
		process.stderr.write(`fusion-harness: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	},
);
