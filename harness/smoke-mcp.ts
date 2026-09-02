/**
 * Drives harness/mcp.ts over stdio exactly as an MCP client would: initialize,
 * tools/list, then one real fusion_opinion call. Pass --stack-only to stop before
 * the paid model call, and --config to exercise a non-default stack.
 */

import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let rootArg: string | undefined;
let configArg: string | undefined;
let stackOnly = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
	const arg = args[index];
	if (arg === "--stack-only") {
		stackOnly = true;
	} else if (arg === "--config") {
		const value = args[++index];
		if (!value || value.startsWith("--")) throw new Error("--config requires a path");
		configArg = path.resolve(value);
	} else if (arg.startsWith("--")) {
		throw new Error(`Unknown option: ${arg}`);
	} else if (rootArg) {
		throw new Error("Usage: smoke-mcp.ts [--stack-only] [--config path] [workspace-root]");
	} else {
		rootArg = arg;
	}
}

// Pass a directory to advertise it as the workspace root, the way VS Code does.
const root = path.resolve(rootArg ?? process.cwd());

const client = new Client({ name: "fh-smoke", version: "1.0.0" }, { capabilities: { roots: {} } });
client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(root).href, name: path.basename(root) }] }));
console.log(`advertising root: ${root}`);
const isBun = path.basename(process.execPath).toLowerCase().startsWith("bun");
await client.connect(
	new StdioClientTransport({
		command: process.execPath,
		args: [...(isBun ? ["run"] : []), fileURLToPath(new URL("./mcp.ts", import.meta.url))],
		env: { ...process.env, ...(configArg ? { FH_MCP_CONFIG: configArg } : {}) } as Record<string, string>,
	}),
);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const stack = await client.callTool({ name: "fusion_stack", arguments: {} });
console.log((stack.content as Array<{ text: string }>)[0].text);

if (!stackOnly) {
	const opinion = await client.callTool({
		name: "fusion_opinion",
		arguments: { prompt: "Read package.json and reply with ONLY the value of the name field. No other words." },
	});
	console.log((opinion.content as Array<{ text: string }>)[0].text);
}

await client.close();
