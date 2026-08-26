---
description: Set up fusion-harness on a GitHub Copilot subscription, including auth and the MCP server
---

# Purpose

Take a fresh clone to a working three-model fan-out on a GitHub Copilot subscription, with the MCP
server registered. No provider API keys.

`docs/copilot-setup.md` is the reference. This command executes it and verifies each step.

## Rules

- **Verify every step before moving on.** A step is done when its check passes, not when its command exits 0.
- **Never print, echo, or store a credential.** Auth is interactive and belongs to the user.
- **Never run a command that triggers a UAC prompt.** If elevation is needed, tell the user the exact
  command and stop. Do not retry with elevation.
- Report what you changed on the machine, so it can be undone.

## Workflow

### 1. Toolchain

Check `node`, `pi`, `bun`, `just`, `jq`, `uv`, `git`. Report each as version-or-MISSING before installing anything.

- Node must be **>= 22.19.0**. pi 0.75+ refuses to start below it.
- pi must be **>= 0.84.2**, which is verified end to end. Also verify `pi --help` lists `--session-id`;
  the harness depends on the capability, not just the version string.
- On Windows, Node 22.x is not in winget (`OpenJS.NodeJS.LTS` is 24.x, `OpenJS.NodeJS` is 26.x) and every
  MSI needs UAC. Prefer the portable install in `docs/copilot-setup.md` §1a: it needs no elevation, leaves
  the system Node untouched, and is undone by deleting one folder. **Verify the SHA-256 against
  nodejs.org's `SHASUMS256.txt` before extracting.**
- On Windows, confirm Git Bash exists at `C:\Program Files\Git\bin\bash.exe`. pi shells through bash.
  `C:\WINDOWS\system32\bash.exe` is the WSL launcher and will not work.

Then `npm install` and `npm test` at the repo root. Expect 34 passing tests and zero paid calls. On a
managed machine, do not bypass its configured npm registry. If installation is blocked, validate the
existing dependency tree and repair missing packages only from an approved feed or verified local cache.

### 2. Authenticate

This part is interactive and the user must do it. Tell them:

1. Run `pi`
2. `/login`
3. Choose **Use a subscription**, then **GitHub Copilot**
4. Press Enter for `github.com`, or enter their GitHub Enterprise Server domain
5. Open <https://github.com/login/device>, enter the displayed code, authorise

Relay the device code, then stop and wait. Do not attempt to complete the browser flow.

The token lands in `~/.pi/agent/auth.json` and is shared by every pi install on the machine.

**Check:** `pi --no-extensions --list-models` lists models under the `github-copilot` provider. This is
the exact command the harness runs at startup, so anything missing here will block launch. If a model
is absent, the user must enable it in VS Code: Copilot Chat → model picker → Enable.

### 3. Stack

Read `.pi/fusion-harness/model-stack-copilot.yaml`. Cross-check every `model:` against the live
`--list-models` output — pi's catalogue grows with pi's version and slots silently go stale. If any slot
is superseded, say so and propose replacements rather than editing without asking.

Keep one model per vendor. Three slots from one vendor mostly agree with themselves, which defeats the point.

**Check:** `just copilot-stack` prints all slots.

### 4. Launch

**Check:** this must print `OK` with no extension error. It validates registration, authentication and
clean-room visibility for every slot:

```
pi -e extensions/fusion-harness/fusion-harness.ts --fh-config .pi/fusion-harness/model-stack-copilot.yaml -p "reply with exactly: OK"
```

Then confirm `just fusion-copilot` boots and shows one coloured dot per slot.

### 5. MCP server

Ask the user which scope they want, then do one, not both:

- **This repo only** — copy `.vscode/mcp.json.example` to `.vscode/mcp.json` and point
  `FH_MCP_CONFIG` at `.pi/fusion-harness/model-stack-copilot.yaml`.
- **Every workspace** — run `MCP: Open User Configuration` (`%APPDATA%\Code\User\mcp.json` on Windows) and
  add the server to the existing `servers` object. Do not overwrite the file. See `docs/copilot-setup.md`
  §5a. **Do not use `${workspaceFolder}`** — it is only resolvable in workspace-scoped config and VS Code
  refuses to start the server with `Variable workspaceFolder can not be resolved`, even with a folder open.
  Omit both `cwd` and `FH_MCP_CWD`; the server asks the client for its workspace roots instead. All other
  paths must be absolute, and prefer `${env:USERPROFILE}` / `${env:LOCALAPPDATA}` over literals because
  Settings Sync carries this file to other machines.

Either way, set `command` to an **absolute path** to the Node binary. VS Code launches MCP servers with
the `PATH` it inherited at startup, so anything installed afterwards fails as `spawn <tool> ENOENT`.

**Free check:** `node harness/smoke-mcp.ts --stack-only --config
.pi/fusion-harness/model-stack-copilot.yaml` lists `fusion_stack`, `fusion_opinion`, `fusion_debate`,
loads the Copilot stack and verifies roots without model calls. Pass a directory as the other argument
to advertise that directory as a workspace root, which tests roots resolution without VS Code.

The same command without `--stack-only` completes one real fan-out and costs one premium request per
slot. Ask for approval before running it.

A newly added user-profile server does not start by itself: tell the user to run **MCP: List Servers**,
select `fusion-harness`, choose **Start**, and accept the trust prompt. Do not judge whether it started
from its log file under `%APPDATA%\Code\logs\` — a healthy server writes nothing to stderr, so that log is
0 bytes either way. Check **MCP: List Servers**, or look for a `node.exe` process whose command line
contains `mcp.ts`.

If the user chose global scope, have them open a **different** project and call `fusion_stack`. Its
`Inspecting:` line must name that project. A lowercase drive letter (`c:\Users\...`) means the path came
from a client root; an uppercase one (`C:\Users\...`) means roots did not resolve and it fell back to
`process.cwd()`. This failure is silent: the agents would read one repository while the user asks about
another, and the answers would still look plausible.

Then tell the user to reload the VS Code window — an agent's tool list is fixed when the chat session
starts, so a newly registered server will not appear in the current conversation.

### 6. Brief the user

Cover, briefly:

- Cost. One premium request per agent per turn. A 3-slot opinion is 3 requests; a 3-round debate is 9.
  The architect's `thinking` level dominates the bill.
- The security boundary. Child agents are read-only, but those tools accept absolute paths and are not
  scoped to the inspected directory — verified, not assumed. Prompt-injected content inside a repo can
  make an agent read `~/.pi/agent/auth.json` or a `.env` and quote it back. For untrusted code, use
  process-level isolation.
- `/fh-fusion` and `/fh-collaborate` are not on MCP by design: they hold the CWD writer lease and an MCP
  client editing the same folder is an unseen second writer.
- Exactly what was installed and where, so it can be reversed.
