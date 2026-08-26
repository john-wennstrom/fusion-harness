/**
 * core.ts — the fusion harness without a TUI.
 *
 * Drives the same clean-room pi children and the same prompt contracts as the pi
 * extension, but renders nothing and depends on no ExtensionAPI. Read-only protocols
 * only: opinion and debate. The writing protocols (/fh-fusion, /fh-collaborate) stay
 * in the extension, where the CWD writer lease is the sole arbiter of who may write.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runChild } from "../extensions/fusion-harness/modules/child-runner.ts";
import { loadModelStack, orderedSlots, type ModelSlot, type ModelStack } from "../extensions/fusion-harness/modules/model-stack.ts";
import { debateClosingPrompt, debateOpeningPrompt, debateRebuttalPrompt, opinionPrompt } from "../extensions/fusion-harness/modules/prompt-library.ts";
import { ANSWER_MAX_BYTES, newRun, READONLY_TOOLS, runError, runOk, truncateBytes, type AgentRun } from "../extensions/fusion-harness/modules/runtime.ts";

export const DEFAULT_TIMEOUT_MS = 600_000;
const PI_PACKAGE = path.join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

export interface AgentResult {
	slot: string;
	role: "ARCHITECT" | "BUILDER";
	model: string;
	thinking: string;
	ok: boolean;
	text: string;
	error?: string;
	ms: number;
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
	toolCalls: number;
}

export interface OpinionResult {
	command: "opinion";
	ok: boolean;
	stack: string;
	prompt: string;
	agents: AgentResult[];
	artifactsDir: string;
	totalMs: number;
	totalCostUsd: number;
}

export interface DebateResult {
	command: "debate";
	ok: boolean;
	stack: string;
	prompt: string;
	rounds: Array<{ round: number; agents: AgentResult[] }>;
	/** Set when the debate stopped before the requested round count, with the reason. */
	halted?: string;
	artifactsDir: string;
	totalMs: number;
	totalCostUsd: number;
}

export interface RunOptions {
	configPath: string;
	prompt: string;
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * Point child-runner at a real pi install. Without this the headless host would spawn
 * itself, because piInvocation defaults to re-running process.argv[1].
 */
export function resolvePiInvocation(): string[] {
	const existing = process.env.FH_PI_INVOCATION;
	if (existing) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(existing);
		} catch {
			throw new Error('FH_PI_INVOCATION is not valid JSON. Expected an array like ["node","/path/to/cli.js"].');
		}
		if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((v) => typeof v === "string")) {
			throw new Error("FH_PI_INVOCATION must be a non-empty JSON array of strings.");
		}
		return parsed as string[];
	}

	const roots = [
		process.env.FH_PI_HOME,
		process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "fusion-node") : undefined,
		process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : undefined,
		path.join(os.homedir(), ".pi", "agent", "npm"),
		path.join(os.homedir(), ".npm-global", "lib"),
		path.join(os.homedir(), ".local", "lib"),
		"/opt/homebrew/lib",
		"/usr/local/lib",
		"/usr/lib",
	].filter((r): r is string => Boolean(r));

	for (const root of roots) {
		const entry = path.join(root, PI_PACKAGE);
		if (!fs.existsSync(entry)) continue;
		const bundled = [path.join(root, "node.exe"), path.join(root, "node"), path.join(root, "bin", "node")].find((p) => fs.existsSync(p));
		const node = bundled ?? (/^node(\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : "node");
		const invocation = [node, entry];
		process.env.FH_PI_INVOCATION = JSON.stringify(invocation);
		return invocation;
	}
	throw new Error(`could not locate a pi install. Set FH_PI_HOME to the prefix containing ${PI_PACKAGE}, or FH_PI_INVOCATION to a JSON array like ["node","/path/to/cli.js"].`);
}

export function loadStack(configPath: string): ModelStack {
	return loadModelStack(configPath);
}

export function describeStack(stack: ModelStack): string {
	const rows = orderedSlots(stack).map((slot) => `- ${slot.name} | ${slot.architect ? "ARCHITECT" : slot.primary ? "BUILDER (Main)" : "BUILDER"} | ${slot.model} | thinking=${slot.thinking}`);
	return [`Stack: ${stack.codename} (${stack.slots.length} slots)`, ...rows].join("\n");
}

function snapshot(run: AgentRun): AgentResult {
	const slot = run.slot!;
	const ok = runOk(run);
	return {
		slot: slot.name,
		role: run.role === "ARCHITECT" ? "ARCHITECT" : "BUILDER",
		model: run.model,
		thinking: slot.thinking,
		ok,
		text: ok ? run.text.trim() : "",
		error: ok ? undefined : runError(run),
		ms: run.ms,
		tokensIn: run.tokensIn,
		tokensOut: run.tokensOut,
		costUsd: run.costUsd,
		toolCalls: run.toolCalls,
	};
}

async function makeArtifactsDir(): Promise<string> {
	return fs.promises.mkdtemp(path.join(os.tmpdir(), "fusion-harness-"));
}

async function save(dir: string, name: string, body: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true });
	await fs.promises.writeFile(path.join(dir, name), body, "utf-8");
}

/** An artifact that cannot be written must never discard an answer that was paid for. */
async function saveBestEffort(dir: string, name: string, body: string): Promise<void> {
	try {
		await save(dir, name, body);
	} catch {
		/* disk full, permissions, path length - the answer still returns */
	}
}

/**
 * Delete fusion-harness-* run directories older than maxAgeMs. Runs keep full prompts,
 * answers and session transcripts, and nothing else ever reclaims them.
 */
export async function sweepArtifacts(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
	const root = os.tmpdir();
	const cutoff = Date.now() - maxAgeMs;
	let removed = 0;
	try {
		for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith("fusion-harness-")) continue;
			const full = path.join(root, entry.name);
			try {
				if ((await fs.promises.stat(full)).mtimeMs > cutoff) continue;
				await fs.promises.rm(full, { recursive: true, force: true });
				removed++;
			} catch {
				/* in use by a concurrent run, or already gone */
			}
		}
	} catch {
		/* unreadable temp dir is not worth failing a run over */
	}
	return removed;
}

function totals(runs: AgentRun[], startedAt: number) {
	return { totalMs: Date.now() - startedAt, totalCostUsd: runs.reduce((sum, run) => sum + run.costUsd, 0) };
}

/** A NaN timeout reaches setTimeout as 1ms and kills every child instantly as "timed out". */
function resolveTimeout(ms: number | undefined): number {
	return Number.isFinite(ms) && (ms as number) > 0 ? (ms as number) : DEFAULT_TIMEOUT_MS;
}

function sessionIdentity(artifactsDir: string, slot: ModelSlot) {
	return { sessionDir: path.join(artifactsDir, "sessions", slot.id), sessionId: `fh-${slot.id}` };
}

export async function runOpinion(opts: RunOptions): Promise<OpinionResult> {
	resolvePiInvocation();
	const stack = loadStack(opts.configPath);
	const slots = orderedSlots(stack);
	const cwd = opts.cwd ?? process.cwd();
	const timeoutMs = resolveTimeout(opts.timeoutMs);
	const runs = slots.map((slot) => newRun(slot.architect ? "ARCHITECT" : "BUILDER", slot.model, slot));
	const startedAt = Date.now();
	const artifactsDir = await makeArtifactsDir();
	await save(artifactsDir, "prompt.md", opts.prompt);
	await save(artifactsDir, "stack.json", JSON.stringify(stack, null, 2));

	await Promise.all(runs.map(async (run) => {
		const slot = run.slot!;
		const agentDir = path.join(artifactsDir, "agents", slot.id);
		await runChild({
			run,
			prompt: opinionPrompt(slot, stack, opts.prompt),
			systemPrompt: slot.systemPrompt,
			appendSystemPrompts: slot.appendSystemPrompts,
			tools: READONLY_TOOLS,
			thinking: slot.thinking,
			...sessionIdentity(artifactsDir, slot),
			cwd,
			timeoutMs,
			signal: opts.signal,
		});
		await saveBestEffort(agentDir, "answer.md", runOk(run) ? run.text : `FAILED: ${runError(run)}`);
	}));

	const result: OpinionResult = {
		command: "opinion",
		ok: runs.every(runOk),
		stack: stack.codename,
		prompt: opts.prompt,
		agents: runs.map(snapshot),
		artifactsDir,
		...totals(runs, startedAt),
	};
	await save(artifactsDir, "summary.json", JSON.stringify(result, null, 2));
	return result;
}

export async function runDebate(opts: RunOptions & { rounds?: number }): Promise<DebateResult> {
	resolvePiInvocation();
	const requested = Number(opts.rounds ?? 3);
	const rounds = Math.min(Math.max(Number.isFinite(requested) ? Math.floor(requested) : 3, 2), 10);
	const stack = loadStack(opts.configPath);
	const slots = orderedSlots(stack);
	const cwd = opts.cwd ?? process.cwd();
	const timeoutMs = resolveTimeout(opts.timeoutMs);
	const runs = slots.map((slot) => newRun(slot.architect ? "ARCHITECT" : "BUILDER", slot.model, slot));
	const startedAt = Date.now();
	const artifactsDir = await makeArtifactsDir();
	await save(artifactsDir, "prompt.md", opts.prompt);
	await save(artifactsDir, "stack.json", JSON.stringify(stack, null, 2));

	const transcript: DebateResult["rounds"] = [];
	let previous: AgentRun[] = [];
	let halted: string | undefined;

	for (let round = 1; round <= rounds; round++) {
		const active = round === 1 ? runs : runs.filter(runOk);
		// A debate needs two positions. Below that there is nobody left to disagree with.
		if (active.length < 2) {
			halted = `stopped before round ${round}: only ${active.length} of ${slots.length} agents still had a usable opinion`;
			break;
		}
		const prior = previous.map((run) => ({ ...run, flow: [...run.flow] }));
		let prompts: Map<string, string>;
		try {
			prompts = new Map(active.map((run) => {
				const slot = run.slot!;
				const text =
					round === 1
						? debateOpeningPrompt(slot, stack, opts.prompt, rounds)
						: round === rounds
							? debateClosingPrompt(slot, opts.prompt, round, rounds, prior)
							: debateRebuttalPrompt(slot, opts.prompt, round, rounds, prior);
				return [slot.id, text];
			}));
		} catch (error) {
			// Rounds already on disk stay valid; only the unbuildable round is lost.
			halted = `stopped before round ${round}: could not build the all-opinions packet: ${error instanceof Error ? error.message : String(error)}`;
			break;
		}
		await Promise.all(active.map(async (run) => {
			const slot = run.slot!;
			const initial = sessionIdentity(artifactsDir, slot);
			const identity = run.sessionRef ? { sessionDir: initial.sessionDir, resume: run.sessionRef } : initial;
			await runChild({
				run,
				prompt: prompts.get(slot.id)!,
				systemPrompt: slot.systemPrompt,
				appendSystemPrompts: slot.appendSystemPrompts,
				tools: READONLY_TOOLS,
				thinking: slot.thinking,
				...identity,
				cwd,
				timeoutMs,
				signal: opts.signal,
			});
			await saveBestEffort(path.join(artifactsDir, "debate", `round-${round}`), `${slot.id}.md`, runOk(run) ? run.text : `FAILED: ${runError(run)}`);
		}));
		transcript.push({ round, agents: active.map(snapshot) });
		previous = active.map((run) => ({ ...run, flow: [...run.flow] }));
	}

	const result: DebateResult = {
		command: "debate",
		ok: halted === undefined && transcript.length === rounds && runs.filter(runOk).length >= 2,
		stack: stack.codename,
		prompt: opts.prompt,
		rounds: transcript,
		halted,
		artifactsDir,
		...totals(runs, startedAt),
	};
	await save(artifactsDir, "summary.json", JSON.stringify(result, null, 2));
	return result;
}

function agentBlock(agent: AgentResult): string {
	const stats = `${(agent.ms / 1000).toFixed(1)}s | ${agent.tokensOut} out | $${agent.costUsd.toFixed(4)}`;
	const head = `### ${agent.slot} - ${agent.model} (${agent.role})\n_${stats}_`;
	return `${head}\n\n${agent.ok ? truncateBytes(agent.text, ANSWER_MAX_BYTES) : `**FAILED** - ${agent.error}`}`;
}

export function toMarkdown(result: OpinionResult | DebateResult): string {
	const foot = `\n---\n_${(result.totalMs / 1000).toFixed(1)}s | $${result.totalCostUsd.toFixed(4)} | artifacts: ${result.artifactsDir}_`;
	if (result.command === "opinion") {
		return [`## Opinions - ${result.agents.length} agents, stack \`${result.stack}\``, ...result.agents.map(agentBlock)].join("\n\n") + foot;
	}
	const rounds = result.rounds.map((r) => [`## Round ${r.round} of ${result.rounds.length}`, ...r.agents.map(agentBlock)].join("\n\n"));
	const halted = result.halted ? [`\n**Debate incomplete** - ${result.halted}`] : [];
	return [`# Debate - stack \`${result.stack}\`, no judge`, ...rounds, ...halted].join("\n\n") + foot;
}
