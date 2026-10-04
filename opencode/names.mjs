import { tools } from '../mcp/src/tool-catalog.mjs';
import { REMOTE_E_COMET_TOOL_NAMES } from '../mcp/src/feedback-tool-calls.mjs';

// OpenCode 2 registers MCP effective names as server + '_' + tool. Resolve the
// whole name against our two reserved registrations; suffixes are not identity.
const names = new Map([
    ...tools.map(({ name }) => [`e-comet-local_${name}`, `mcp__e-comet-local__${name}`]),
    ...[...REMOTE_E_COMET_TOOL_NAMES, 'report_issue'].map((name) => [`e-comet_${name}`, `mcp__e-comet__${name}`]),
]);
export const mapToolName = (name) => names.get(name);
export const isFeedbackTool = (name) => name === 'e-comet-local_prepare_e_comet_feedback' || name === 'e-comet-local_submit_e_comet_feedback';
