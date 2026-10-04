import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { processHookEvent as browserHook } from '../hooks/browser-job-handoff.mjs';
import { processHookEvent as feedbackHook, prepareInputWithTrustedTranscript } from '../hooks/feedback-handoff.mjs';
import { runHook as updateHook } from '../hooks/check-update.mjs';
import { resolveLocalStateDir } from '../mcp/src/state-paths.mjs';
import { sweepExpired } from '../mcp/src/file-retention.mjs';
import { encodeTranscript } from './transcript.mjs';
import { mapToolName, isFeedbackTool } from './names.mjs';

export class OpenCodeHandoffError extends Error {
    constructor(message) { super(message); this.name = 'OpenCodeHandoffError'; }
}
const fail = (message) => { throw new OpenCodeHandoffError(message); };
export const assertSupportedHost = (app) => {
    const version = /^2\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(app?.version ?? '');
    if (!version || (Number(version[1]) === 0 && Number(version[2]) < 22)) fail('OPENCODE_UNSUPPORTED_HOST: e-Comet requires OpenCode 2.0.22 or later in the 2.x series. Update OpenCode before loading this native package.');
};
const validateIdentity = (event) => {
    for (const key of ['sessionID', 'messageID', 'id']) if (typeof event?.[key] !== 'string' || !event[key] || Buffer.byteLength(event[key]) > 512) fail('OPENCODE_INVALID_EVENT: The native host did not provide a valid session, message and call identity. Check the OpenCode plugin integration.');
};
const callKey = ({ sessionID, messageID, id }) => JSON.stringify([sessionID, messageID, id]);
const outcome = (result) => {
    if (result.exitCode !== 0) fail(result.stderr || 'OPENCODE_HANDOFF_FAILED: The trusted hook failed.');
    if (!result.stdout) return undefined;
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    if (output?.permissionDecision === 'deny') fail(output.permissionDecisionReason);
    return output;
};

export const createOpenCodeAdapter = ({ ctx, pluginRoot, dataRoot, env = process.env, runtime = process, now = Date.now, fetchImpl }) => {
    const root = resolve(pluginRoot);
    const storage = resolve(dataRoot ?? join(resolveLocalStateDir({ env }), 'opencode'));
    const hookEnv = { ...env, PLUGIN_DATA: storage, CLAUDE_PLUGIN_DATA: storage };
    const snapshots = new Map();
    const snapshotDirectory = join(storage, 'transcripts-v1');
    const cleanup = async (key) => {
        const path = snapshots.get(key);
        if (path) { await rm(path, { force: true }); snapshots.delete(key); }
    };
    const hookEvent = (event, phase) => ({ hook_event_name: phase, tool_name: mapToolName(event.tool), session_id: event.sessionID, tool_use_id: event.id, tool_input: event.input });
    return {
        dataRoot: storage,
        registerMcp(editor) {
            // Reuse the trusted host runtime, including compiled Bun hosts; this
            // needs neither PATH discovery nor a separate seller Node install.
            // Bun Windows concurrent retention warnings: accepted residual in
            // docs/local-agent-architecture.md#accepted-residuals.
            const configs = {
                'e-comet': { type: 'remote', url: 'https://mcp.e-comet.io/mcp', oauth: {}, protocol: 'legacy', codemode: false },
                'e-comet-local': { type: 'local', command: [runtime.execPath, join(root, 'mcp/src/server.mjs')], cwd: root, environment: { PLUGIN_DATA: storage, CLAUDE_PLUGIN_DATA: storage, ...(runtime.versions.bun ? { BUN_BE_BUN: '1' } : {}) }, timeout: { execution: 7_200_000 }, protocol: 'legacy', codemode: false },
            };
            // Inspect both before either write, so a collision never partially registers.
            for (const [name, config] of Object.entries(configs)) {
                const existing = editor.get(name);
                if (existing !== undefined && !isDeepStrictEqual(existing, config)) fail(`OPENCODE_SERVER_COLLISION: MCP name ${name} is already configured. Remove or rename the existing registration before loading the e-Comet native package.`);
            }
            // The child already inherits host environment. Never serialize unrelated
            // host credentials into inspectable MCP configuration.
            for (const [name, config] of Object.entries(configs)) editor.set(name, config);
        },
        permission(event) {
            if (isFeedbackTool(event.action) && event.effect !== 'deny') {
                event.effect = 'ask';
                event.message = 'Approve this e-Comet feedback call. Preparation keeps the selected history locally; submission uploads the prepared report.';
            }
        },
        async before(event) {
            if (!mapToolName(event?.tool)) return;
            validateIdentity(event);
            const envelope = hookEvent(event, 'PreToolUse');
            const key = callKey(event);
            try {
                if (event.tool === 'e-comet-local_prepare_e_comet_feedback') {
                    // Validate authored fields before requesting or retaining context. A dummy
                    // trusted path permits includeTranscript validation without exporting yet.
                    prepareInputWithTrustedTranscript({ ...envelope, transcript_path: join(snapshotDirectory, 'validation.jsonl') });
                    await cleanup(key);
                    const context = await ctx.session.context({ sessionID: event.sessionID });
                    await mkdir(snapshotDirectory, { recursive: true, mode: 0o700 });
                    if (process.platform !== 'win32') await chmod(snapshotDirectory, 0o700);
                    await sweepExpired({ directory: snapshotDirectory, ownName: (name) => /^[a-f0-9]{64}-[0-9a-f-]{36}\.jsonl$/.test(name), retentionMs: 24 * 60 * 60 * 1000, now: now() });
                    const hash = createHash('sha256').update(key).digest('hex');
                    const path = join(snapshotDirectory, `${hash}-${randomUUID()}.jsonl`);
                    await writeFile(path, encodeTranscript(context, { includeTranscript: event.input.includeTranscript }), { flag: 'wx', mode: 0o600 });
                    snapshots.set(key, path);
                    envelope.transcript_path = path;
                }
                for (const handler of [browserHook, feedbackHook]) {
                    const output = outcome(await handler(envelope, { env: hookEnv, nowMs: now() }));
                    if (output?.updatedInput !== undefined) event.input = output.updatedInput;
                }
            } catch (error) { await cleanup(key); throw error; }
        },
        async after(event) {
            if (!mapToolName(event?.tool)) return;
            validateIdentity(event);
            try {
                // OpenCode converts MCP isError into status:error. Failed grants must
                // remain failed results and must never be staged from partial output.
                if (event.status !== 'completed') return;
                const envelope = { ...hookEvent(event, 'PostToolUse'), tool_response: { structuredContent: event.result?.output, content: event.result?.content ?? [] } };
                for (const handler of [browserHook, feedbackHook]) {
                    const output = outcome(await handler(envelope, { env: hookEnv, nowMs: now() }));
                    if (typeof output?.additionalContext === 'string') event.result.content = [...(event.result.content ?? []), { type: 'text', text: output.additionalContext }];
                }
                // The shared update checker owns cache and once-per-session semantics.
                // Its optional notice never authorizes or replaces a business result.
                try {
                    await mkdir(storage, { recursive: true, mode: 0o700 });
                    const notice = await updateHook({ input: hookEvent(event, 'PreToolUse'), env: { ...hookEnv, PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: root }, fetchImpl, nowMs: now() });
                    if (notice) {
                        const context = JSON.parse(notice).hookSpecificOutput?.additionalContext;
                        if (typeof context === 'string') event.result.content = [...(event.result.content ?? []), { type: 'text', text: context }];
                    }
                } catch { /* Optional update failure never affects completed work. */ }
            } finally { await cleanup(callKey(event)); }
        },
        async dispose() { for (const key of snapshots.keys()) await cleanup(key); },
    };
};
