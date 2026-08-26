# Running fusion-harness on a GitHub Copilot subscription

The default stacks use API keys for Anthropic, Google, Fireworks, OpenAI and OpenRouter. This optional
stack runs the same protocols on one **GitHub Copilot** subscription instead. Pi has a
`github-copilot` provider, and each agent in the stack is a separate Pi process with its own `--model`,
so one subscription drives three different frontier models at once — which the VS Code model picker
cannot do.

Follow this top to bottom. Every step has a verification you can run.

---

## 1. Prerequisites

| Tool | Why | Install |
| --- | --- | --- |
| **Node ≥ 22.19.0** | pi 0.75+ refuses to run below this | see [1a](#1a-node-on-windows) |
| **pi ≥ 0.84.2** | the harness needs `--session-id`; 0.84.2 is verified end to end | `npm install -g @earendil-works/pi-coding-agent@latest` |
| **bun** | test runner, and it runs the `harness/` TypeScript directly | `winget install Oven-sh.Bun` |
| **just** | recipe runner | `winget install Casey.Just` |
| **jq**, **uv** | gate tooling used by `/fh-auto-validate` | `winget install jqlang.jq astral-sh.uv` |
| **Git Bash** (Windows only) | pi shells out through bash on Windows | [git-scm.com](https://git-scm.com/download/win) |

On macOS/Linux: `brew install just jq uv bun`, and Node from your usual version manager.

> **Windows:** pi looks for bash in this order — `shellPath` in `~/.pi/agent/settings.json`, then
> `C:\Program Files\Git\bin\bash.exe`, then `bash.exe` on `PATH`. Note that
> `C:\WINDOWS\system32\bash.exe` is the **WSL launcher**, not a usable shell for pi. Install Git for
> Windows and let pi find it at the second location.

### 1a. Node on Windows

Node 22.x is no longer in winget — `OpenJS.NodeJS.LTS` resolves to 24.x and `OpenJS.NodeJS` to 26.x.
Every MSI also needs a UAC prompt. If you want to leave your system Node alone, install a portable
Node 22 into your user profile and put pi inside it. Nothing else on the machine changes, and undoing
it is deleting one folder.

```powershell
$ver = 'v22.20.0'
$zip  = "$env:TEMP\node-$ver-win-x64.zip"
Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip -UseBasicParsing
Invoke-WebRequest "https://nodejs.org/dist/$ver/SHASUMS256.txt" -OutFile "$env:TEMP\SHASUMS256.txt" -UseBasicParsing

# Verify before extracting. Do not skip this.
$expected = ((Get-Content "$env:TEMP\SHASUMS256.txt" | Select-String "node-$ver-win-x64.zip") -split '\s+')[0]
if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $expected) { throw 'checksum mismatch' }

Expand-Archive $zip "$env:LOCALAPPDATA\fusion-node-tmp" -Force
Move-Item "$env:LOCALAPPDATA\fusion-node-tmp\node-$ver-win-x64" "$env:LOCALAPPDATA\fusion-node"
Remove-Item "$env:LOCALAPPDATA\fusion-node-tmp" -Recurse -Force

& "$env:LOCALAPPDATA\fusion-node\npm.cmd" install -g @earendil-works/pi-coding-agent@latest --prefix "$env:LOCALAPPDATA\fusion-node"
```

**Verify:**

```powershell
& "$env:LOCALAPPDATA\fusion-node\node.exe" --version   # v22.20.0 or higher
& "$env:LOCALAPPDATA\fusion-node\pi.cmd" --version     # 0.84.2 or higher
& "$env:LOCALAPPDATA\fusion-node\pi.cmd" --help | Select-String -- '--session-id'
```

The [justfile](../justfile) puts `%LOCALAPPDATA%\fusion-node` at the front of `PATH` on Windows
automatically, so `just` recipes pick this toolchain up without any further wiring.

### 1b. Repo dependencies

```bash
npm install     # the yaml parser, the MCP SDK and zod
npm test        # 34 deterministic tests, zero paid calls
```

On a managed machine, keep the configured corporate npm registry. Do not work around policy by making a
persistent registry change. If installation is blocked, first check whether the existing dependency tree
is usable:

```bash
npm ls --all
npm test
node harness/smoke-mcp.ts --stack-only --config .pi/fusion-harness/model-stack-copilot.yaml
```

The Node smoke matters even when Bun's tests pass: it loads the MCP SDK paths used by VS Code and can
find a missing transitive package that the deterministic tests do not import. Repair missing packages
from an approved feed or a verified local cache, then rerun all three checks.

---

## 2. Authenticate against GitHub Copilot

Interactive, once. The token is written to `~/.pi/agent/auth.json`, is shared by every pi install on
the machine, and survives pi upgrades.

```
pi
```

Then in the TUI:

1. `/login`
2. **Use a subscription**
3. **GitHub Copilot**
4. Press Enter for `github.com`, or type your GitHub Enterprise Server domain
5. Open <https://github.com/login/device> and enter the code shown, then authorise

**Verify:**

```bash
pi --no-extensions --list-models
```

Every model in your stack must appear with the `github-copilot` provider. This exact command is what
the harness itself runs at startup to decide whether a stack is runnable, so if a model is missing
here the harness will refuse to launch.

> If a model errors with **"model not supported"**, enable it in VS Code: Copilot Chat → model picker
> → select the model → **Enable**. pi can only use models your account has switched on.

---

## 3. Configure the stack

[.pi/fusion-harness/model-stack-copilot.yaml](../.pi/fusion-harness/model-stack-copilot.yaml) holds
three slots, one per vendor. Agreement across vendors is the signal worth paying for; three slots on
the same vendor mostly agree with themselves.

```yaml
- name: rune
  model: github-copilot/claude-opus-5
  thinking: high
  architect: true
```

Rules the loader enforces: 2–5 slots, exactly one `architect: true`, exactly one non-architect
`primary: true`, unique names matching `[A-Za-z0-9_-]{1,16}`, fully qualified `provider/id` models,
quoted `#RRGGBB` colours.

**Model choice is perishable.** Pi's Copilot catalogue changes with its version. After any pi upgrade,
re-run `pi --no-extensions --list-models` and check whether your slots have been superseded. Nothing
warns you.

**Verify:**

```bash
just copilot-stack
```

---

## 4. Launch

```bash
just fusion-copilot                    # full TUI, all protocols
just copilot-opinion "your question"   # headless fan-out, markdown to stdout
just copilot-debate "your question" --rounds 3 # headless N-way debate
```

Inside the TUI: `/fh` for the command index and the model bar, `/fh-opinion`, `/fh-debate`,
`/fh-fusion`, `/fh-collaborate`, `/fh-auto-validate`, `/fh-only`, `/fh-model`.

The real gate is the extension's own startup validation. It checks every slot three ways — registered,
authenticated, and visible to a clean-room child launched with `--no-extensions` — and refuses to
start if any slot fails. A one-line non-interactive check:

```bash
pi -e extensions/fusion-harness/fusion-harness.ts \
   --fh-config .pi/fusion-harness/model-stack-copilot.yaml \
   -p "reply with exactly: OK"
```

---

## 5. Wire up the MCP server

Copy [.vscode/mcp.json.example](../.vscode/mcp.json.example) to `.vscode/mcp.json`, edit `command` to
an **absolute path** to your Node binary, and set `FH_MCP_CONFIG` to
`${workspaceFolder}/.pi/fusion-harness/model-stack-copilot.yaml`.

Use an absolute path deliberately. VS Code launches MCP servers with the `PATH` it inherited at
startup, so a tool installed after VS Code was opened will fail with `spawn <tool> ENOENT` even though
it works fine in your terminal.

Node 22.19+ runs the `.ts` files directly via native type stripping, so no build step and no bundler.

| Variable | Purpose |
| --- | --- |
| `FH_MCP_CWD` | Directory the read-only agents inspect, never a tool argument. Omit it and the server uses the client's first workspace root, falling back to its own `process.cwd()` |
| `FH_MCP_CONFIG` | Path to the stack YAML |
| `FH_MCP_TIMEOUT_S` | Per-child timeout in seconds. Default 600. Raise it if your architect runs long |
| `FH_PI_HOME` | Prefix containing `node_modules/@earendil-works/pi-coding-agent`. Only needed if pi is not auto-discovered |
| `FH_PI_INVOCATION` | Escape hatch: JSON array `["node","/abs/path/cli.js"]`. Overrides discovery entirely |

Three tools are exposed: `fusion_stack`, `fusion_opinion`, `fusion_debate`. All read-only.

**Verify** — first connect over stdio, list the tools, load the stack, and exercise MCP roots without a
model call:

```bash
node harness/smoke-mcp.ts --stack-only --config .pi/fusion-harness/model-stack-copilot.yaml
```

The full smoke adds one real fan-out. With the default three-slot stack it consumes three premium
requests:

```bash
node harness/smoke-mcp.ts --config .pi/fusion-harness/model-stack-copilot.yaml
```

Then reload the VS Code window. Your MCP tool list is fixed when a chat session starts, so a newly
registered server will not appear in an existing conversation.

### 5a. Making it available in every workspace

The workspace file above only works inside this repo. To fan a question out across your models from
*any* project, register the server in your **user profile** instead: run `MCP: Open User Configuration`
(`%APPDATA%\Code\User\mcp.json` on Windows) and add an entry to the existing `servers` object. Do not do
both, or the same server is registered twice in this repo.

**Do not use `${workspaceFolder}` here.** It is only resolvable in workspace-scoped configuration. In a
user-profile config VS Code refuses to start the server with:

```
Error starting fusion-harness: CodeExpectedError: Variable workspaceFolder can not be resolved. Please open a folder.
```

That happens even with a folder open.

So omit `cwd` **and** `FH_MCP_CWD`. The server then asks the client where it is, using the MCP `roots`
capability — VS Code reports the open workspace folder, and the agents inspect that. Resolution order is
`FH_MCP_CWD` → first client root → the server's own `process.cwd()`, and it is recalculated on every tool
call, so switching folders is picked up without a restart.

Every remaining path must be absolute. Prefer `${env:USERPROFILE}` and `${env:LOCALAPPDATA}` over literal
paths — MCP configuration is covered by Settings Sync, and a hardcoded `C:\Users\yourname\...` is wrong on
the next machine. `FH_MCP_CONFIG` in particular has to be absolute, because the stack YAML only exists in
this repo.

If the clone is under corporate OneDrive, use `${env:OneDriveCommercial}` as the path root instead of
`${env:USERPROFILE}`. If Node is installed system-wide rather than inside `fusion-node`, use
`${env:ProgramFiles}\\nodejs\\node.exe` for `command`; `FH_PI_HOME` can still point at the separate pi
prefix.

```jsonc
"fusion-harness": {
  "type": "stdio",
  "command": "${env:LOCALAPPDATA}\\fusion-node\\node.exe",
  "args": ["${env:USERPROFILE}\\Documents\\GitHub\\fusion-harness\\harness\\mcp.ts"],
  "env": {
    "FH_MCP_CONFIG": "${env:USERPROFILE}\\Documents\\GitHub\\fusion-harness\\.pi\\fusion-harness\\model-stack-copilot.yaml",
    "FH_MCP_TIMEOUT_S": "1200",
    "FH_PI_HOME": "${env:LOCALAPPDATA}\\fusion-node"
  }
}
```

A newly added user-profile server does not start on its own. Run **MCP: List Servers**, pick
`fusion-harness`, choose **Start**, and accept the trust prompt.

Do not use the log file under `%APPDATA%\Code\logs\<timestamp>\window1\` to check whether it is running.
A healthy server writes nothing to stderr, so that log stays 0 bytes whether it started or not. **MCP:
List Servers** shows the real state, or look for the process directly:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*mcp.ts*' }
```

**Verify:** open a *different* project and call `fusion_stack`. Its last line reads `Inspecting: <path>`,
and that path must be the project you have open. A path with a **lowercase drive letter** (`c:\Users\...`)
came from a client root; an uppercase one (`C:\Users\...`) came from the `process.cwd()` fallback, which
means roots did not resolve. To test the same mechanism without VS Code, pass a directory to the smoke
client — it advertises that directory as a workspace root exactly as VS Code does:

```bash
node harness/smoke-mcp.ts --stack-only \
  --config /absolute/path/to/fusion-harness/.pi/fusion-harness/model-stack-copilot.yaml \
  /path/to/some/other/project
```

---

## 6. Security boundary

Read this before pointing the MCP server at code you did not write.

Child agents get pi's read-only tools — `read`, `grep`, `find`, `ls`. They cannot write, edit, or run
shell commands. **But those tools accept absolute paths and are not scoped to the inspected
directory.** This was verified, not assumed: a child asked for `C:\Windows\win.ini` returned its
contents.

Fixing the directory at startup stops the *calling* model redirecting the agents. It does not stop
prompt-injected text inside the inspected repository instructing an agent to read
`~/.pi/agent/auth.json`, a `.env`, or an SSH key and quote it back in its answer.

- For your own code, this is fine.
- For untrusted code, run pi under process-level isolation. See pi's own `docs/containerization.md`.
- If you review a repo containing live credentials, stage a copy without them and point `--cwd` at
  the copy.

`/fh-fusion` and `/fh-collaborate` are deliberately **not** exposed over MCP. They hold the CWD writer
lease, and an MCP client editing the same folder is a second writer the lease cannot see.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Unknown option: --session-id` on every child | pi lacks the required flag | upgrade pi to 0.84.2 or later, then verify `pi --help` lists `--session-id` |
| `<model> is not visible to clean-room children` | model not enabled on the account, or a stale pi | enable it in the VS Code model picker; check `pi --no-extensions --list-models` |
| `spawn bun ENOENT` from VS Code | VS Code's inherited `PATH` predates the install | use an absolute `command` in `.vscode/mcp.json` |
| `recipe could not be run because just could not find the shell sh` | Windows has no `sh` | already handled by `set windows-shell` in the justfile |
| `could not locate a pi install` | pi outside the searched prefixes | set `FH_PI_HOME`, or `FH_PI_INVOCATION` |
| Children die instantly, all reported as `timed out` | non-numeric `FH_MCP_TIMEOUT_S` reaching `setTimeout` as `NaN` | guarded now; check the value anyway |
| `Could not resolve "@earendil-works/pi-tui"` | you tried to bundle the extension | expected. pi injects that at load time. Do not bundle it |
| No models at all | not logged in | `/login` → Use a subscription → GitHub Copilot |

Every run writes an inspectable directory under the OS temp dir: `fusion-harness-*`, containing
`stack.json`, the prompt, per-slot answers and `summary.json`. `sweepArtifacts()` reclaims those older
than seven days when the MCP server starts.

---

## 8. Cost

Every agent in the stack costs one premium request per turn. A three-slot `/fh-opinion` is three
requests, not one. A three-round `/fh-debate` is nine. Observed on a trivial prompt with Opus 5 as
architect: ~$0.05 and ~8s for a three-model fan-out; a heavy code review reached $0.85.

The architect's `thinking` level is where the money goes. Dropping it from `high` to `medium` is the
single biggest lever. Cheap secondary slots — `claude-haiku-4.5`, `gpt-5.4-mini`, `grok-code-fast-1` —
still give you genuine cross-vendor disagreement at a fraction of the cost.
