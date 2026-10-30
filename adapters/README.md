# Host adapters

Pro-Fetch is an MCP server: it advertises tools and refuses illegal moves. It cannot make the
connected model think in a certain way (spec §15.4), so running the MexaPlan → SmartToDo →
MaxEffort cycle on substantial work depends on an instruction the host chooses to carry. These
files are that instruction, per host.

Every file below is generated from `HOST_INSTRUCTION` in `src/tools/workflow/workflow.ts` — the
same text `pro_fetch_workflow {action:"introduce"}` returns. Change it there and run
`npm run gen:adapters`; a test fails if a file drifts from the source.

| Host | File |
|---|---|
| Claude Code | [adapters/claude-code.md](./claude-code.md) |
| Codex CLI | [adapters/codex.md](./codex.md) |
| Gemini CLI | [adapters/gemini-cli.md](./gemini-cli.md) |
| GitHub Copilot CLI | [adapters/copilot-cli.md](./copilot-cli.md) |
| OpenClaw / other MCP clients | [adapters/openclaw.md](./openclaw.md) |

## What an adapter has to do (§15.2)

- configure the MCP connection;
- install the instruction block above (or a skill carrying it);
- open a separate agent/session for the audit when the host can, so the review is independent
-   rather than the same context grading its own plan;
- use the host's own model and credentials — Pro-Fetch never asks for a separate LLM API key;
- map the host's file/terminal/patch abilities onto the tools it exposes;
- verify the workflow actually ran: `pro_fetch_workflow {action:"introduce"}` must answer, and a
-   finished job must be reachable through `status`.

## The honest limit

A client that only allows connecting an MCP server, with no way to carry an instruction, cannot be
made to run the three phases automatically. In that case the gates still hold for every call the
host does make through the workflow — nothing can be marked complete without evidence — but the
automatic cycle is not guaranteed, and this repo does not claim it is.
