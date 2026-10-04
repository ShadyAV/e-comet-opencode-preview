# OpenCode 2 native integration

The native package registers exactly `e-comet` and `e-comet-local` and maps host
`server_tool` names to the shared hook contract. It requires OpenCode 2.0.22+ in
the 2.x line and Node22+. A loaded Claude/Codex manifest is not this integration.

For `OPENCODE_SERVER_COLLISION`, inspect the user's explicit MCP entries: the
same two names must be owned by the native package. Remove or rename the duplicate
registration through the user's normal configuration workflow, then start a new
session. Do not change a different server's name or credentials automatically.

For an observed remote authorization error or `needs_auth`, use OpenCode's
MCP authentication action for e-comet and complete sign-in in the browser.
Do not request credentials in chat. OpenCode owns refresh and credential storage.
Do not use the Codex-specific `codex_mcp_auth` or `hook_permissions` probes to
describe OpenCode. A listed server is not proof of a successful business call.

For `OPENCODE_HANDOFF_FAILED`, retain the tool's safe reason and completed work.
Do not repeat browser_job until the reported storage/integration issue is resolved.
The adapter supplies trusted session/call identity; no model-provided token,
transcript path or feedback signature is an acceptable workaround.

For feedback, preserve the user's history choice and follow the local tool
contract. Preparation and submission each require host approval. A rejected
approval performs no tool action; a claim consumed before approval may need fresh
authorization after an explicit user-directed retry. Never repeat an uncertain
upload. The adapter exports only the current host session and deletes its temporary
snapshot after preparation.

Installation and update instructions: [OpenCode guide](../../../opencode/README.md).
