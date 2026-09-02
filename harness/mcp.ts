/**
 * mcp.ts — the read-only fusion protocols as MCP tools.
 *
 * Exposes /fh-opinion and /fh-debate to any MCP client (VS Code Copilot Chat, Claude
 * Desktop, ...). Deliberately does NOT expose /fh-fusion or /fh-collaborate: those hold
 * the CWD writer lease, and an MCP client editing the same folder is a second writer the
 * lease knows nothing about.
 *
 * SECURITY BOUNDARY — read this before pointing it at code you do not trust.
 * Child agents get pi's read-only tools (read, grep, find, ls). They cannot write, run
 * shell commands, or edit. They CAN read absolute paths: the tools are not scoped to the
 * inspected directory. Verified — a child asked for C:\Windows\win.ini returned it.
 * The inspected directory comes from FH_MCP_CWD or the client's workspace roots, never
 * from a tool argument, so the CALLING model cannot redirect the agents. That does not
 * stop prompt-injected text inside the inspected repo instructing an agent to read
 * ~/.pi/agent/auth.json, .env or an SSH key and quote it back in its answer. For
 * untrusted code, run this under process-level isolation — see pi's docs/containerization.md.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { describeStack, loadStack, runDebate, runOpinion, sweepArtifacts, toMarkdown } from "./core.ts";

const EXPLICIT_CWD = process.env.FH_MCP_CWD ? path.resolve(process.env.FH_MCP_CWD) : undefined;
const EXPLICIT_CONFIG = process.env.FH_MCP_CONFIG ? path.resolve(process.env.FH_MCP_CONFIG) : undefined;
const timeoutS = Number(process.env.FH_MCP_TIMEOUT_S ?? 600);
const TIMEOUT_MS = (Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS : 600) * 1000;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };

// Children are spawned detached, so nothing reaps them if this process dies mid-run.
const shutdown = new AbortController();
const until = (request?: AbortSignal) => (request ? AbortSignal.any([shutdown.signal, request]) : shutdown.signal);

/**
 * Which directory the agents inspect, in priority order: an explicit FH_MCP_CWD, then the
 * client's first workspace root, then our own cwd. Roots matter for a user-profile install:
 * `${workspaceFolder}` is only resolvable in workspace-scoped config, so a globally
 * registered server has to ask the client where it is. Resolved per call, because the user
 * can switch folders while the server keeps running.
 */
async function resolveCwd(): Promise<string> {
	if (EXPLICIT_CWD) return EXPLICIT_CWD;
	try {
		const { roots } = await server.server.listRoots();
		const first = roots.find((root) => root.uri.startsWith("file://"));
		if (first) return path.resolve(fileURLToPath(first.uri));
	} catch {
		/* client advertises no roots capability */
	}
	return process.cwd();
}

const configFor = (cwd: string) => EXPLICIT_CONFIG ?? path.join(cwd, ".pi", "fusion-harness", "model-stack-fusion.yaml");

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });
const failure = (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `fusion-harness: ${error instanceof Error ? error.message : String(error)}` }] });

const server = new McpServer({ name: "fusion-harness", version: "1.0.0" });

server.registerTool(
	"fusion_stack",
	{
		title: "Show fusion stack",
		description: "List the models configured in the fusion stack, with their roles and thinking levels. Call this first if you need to know which models will answer.",
		inputSchema: {},
		annotations: READ_ONLY,
	},
	async () => {
		try {
			const cwd = await resolveCwd();
			return text(`${describeStack(loadStack(configFor(cwd)))}\n\nInspecting: ${cwd}`);
		} catch (error) {
			return failure(error);
		}
	},
);

server.registerTool(
	"fusion_opinion",
	{
		title: "Fan out to every model",
		description:
			"Ask every model in the fusion stack the same question independently and return all answers side by side. Each agent reads the codebase with read-only tools and cannot modify anything. Use for second opinions on architecture, code review, and any judgement call where one model's answer is not enough. Costs one request per configured model.",
		inputSchema: {
			prompt: z.string().min(1).describe("The question. Be specific and name the files to read; each agent starts with no context."),
		},
		annotations: READ_ONLY,
	},
	async ({ prompt }, extra) => {
		try {
			const cwd = await resolveCwd();
			return text(toMarkdown(await runOpinion({ configPath: configFor(cwd), prompt, cwd, timeoutMs: TIMEOUT_MS, signal: until(extra?.signal) })));
		} catch (error) {
			return failure(error);
		}
	},
);

server.registerTool(
	"fusion_debate",
	{
		title: "Debate across models",
		description:
			"Run an N-round debate across every model in the fusion stack. Round 1 is independent opinions; every later round shows each agent all the other agents' prior positions so they can concede, hold, or refine. There is no judge. Read-only throughout. Use when the models are likely to disagree and you want the disagreement surfaced rather than averaged. Costs rounds x models requests.",
		inputSchema: {
			prompt: z.string().min(1).describe("The proposition to debate. Sharper and more falsifiable is better."),
			rounds: z.number().int().min(2).max(10).optional().describe("Rounds including opening and closing. Default 3."),
		},
		annotations: READ_ONLY,
	},
	async ({ prompt, rounds }, extra) => {
		try {
			const cwd = await resolveCwd();
			return text(toMarkdown(await runDebate({ configPath: configFor(cwd), prompt, rounds, cwd, timeoutMs: TIMEOUT_MS, signal: until(extra?.signal) })));
		} catch (error) {
			return failure(error);
		}
	},
);

const transport = new StdioServerTransport();
transport.onclose = () => shutdown.abort();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		shutdown.abort();
		process.exit(0);
	});
}

void sweepArtifacts();
await server.connect(transport);
