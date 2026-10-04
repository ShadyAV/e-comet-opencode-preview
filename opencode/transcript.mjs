import { redactFeedbackText, foldFeedbackLineEndings } from '../mcp/src/feedback-report.mjs';
import { projectFeedbackToolOutcome } from '../mcp/src/feedback-tool-calls.mjs';
import { FEEDBACK_MAX_BYTES } from '../mcp/src/config.mjs';
import { mapToolName } from './names.mjs';

const privateField = /^(?:trigger_?url|feedback_?(?:claim|session|adapter)|transcript_?path|upload_?url|required_?headers|authorization|cookie|token|secret|password|api_?key|access_?token|refresh_?token)$/i;
const safeText = (text) => redactFeedbackText(foldFeedbackLineEndings(text)).toWellFormed();
// Select JSON values, discarding transport credentials before the shared text
// redactor. Files, provider state and hidden reasoning never enter this adapter.
const safeValue = (value, depth = 0) => {
    if (depth > 32) return '[nested value omitted]';
    if (typeof value === 'string') return value.startsWith('data:') ? '[attachment omitted]' : safeText(value);
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (Array.isArray(value)) return value.map((item) => safeValue(item, depth + 1));
    if (!value || typeof value !== 'object') return undefined;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !privateField.test(key)).map(([key, item]) => [key, safeValue(item, depth + 1)]));
};
const timestamp = (time) => {
    const value = time?.created;
    const numeric = typeof value === 'number' ? value : value?.epochMillis;
    if (Number.isFinite(numeric)) return new Date(numeric).toISOString();
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
    return undefined;
};

/** Normalize native OpenCode 2 context into the shared diagnostic reader's
 * Claude-shaped JSONL records. `source` records the actual host provenance;
 * this is a selected native snapshot, never a claim to a Claude transcript. */
export const encodeTranscript = (messages, { includeTranscript = false, maxBytes = FEEDBACK_MAX_BYTES } = {}) => {
    if (!Array.isArray(messages) || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('Invalid OpenCode context snapshot');
    const lines = [];
    let total = 0;
    const append = (type, content, time) => {
        const record = Buffer.from(JSON.stringify({ source: 'opencode', type, ...(time ? { timestamp: time } : {}), message: { content } }) + '\n');
        if (record.length > maxBytes) { lines.length = 0; total = 0; return; }
        lines.push(record); total += record.length;
        while (total > maxBytes) total -= lines.shift().length;
    };
    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const at = timestamp(message.time);
        if (includeTranscript && message.type === 'user' && typeof message.text === 'string') append('user', [{ type: 'text', text: safeText(message.text) }], at);
        if (message.type !== 'assistant' || !Array.isArray(message.content)) continue;
        for (const part of message.content) {
            if (!part || typeof part !== 'object') continue;
            if (includeTranscript && part.type === 'text' && typeof part.text === 'string') append('assistant', [{ type: 'text', text: safeText(part.text) }], at);
            if (part.type !== 'tool' || typeof part.name !== 'string' || typeof part.id !== 'string') continue;
            const name = mapToolName(part.name) ?? part.name;
            append('assistant', [{ type: 'tool_use', id: part.id, name, ...(includeTranscript ? { input: safeValue(part.state?.input) } : {}) }], timestamp(part.time) ?? at);
            const state = part.state;
            if (!state || !['completed', 'error'].includes(state.status)) continue;
            const texts = (Array.isArray(state.content) ? state.content : []).filter((item) => item?.type === 'text' && typeof item.text === 'string').map(({ text }) => text);
            // MCP isError becomes native ToolStateError; OpenCode keeps its result
            // prose in error.message when there is no text content. Select only that
            // observed message, never a stack, cause, or provider-specific internals.
            if (texts.length === 0 && state.status === 'error' && typeof state.error?.message === 'string') texts.push(state.error.message);
            const outcome = projectFeedbackToolOutcome(texts.join('\n'), state.status === 'error', name);
            const content = includeTranscript ? texts.map((text) => {
                try { return JSON.stringify(safeValue(JSON.parse(text))); } catch { return safeText(text); }
            }).join('\n') : JSON.stringify(outcome ?? {});
            append('user', [{ type: 'tool_result', tool_use_id: part.id, content, ...(state.status === 'error' ? { is_error: true } : {}) }], timestamp(part.time) ?? at);
        }
    }
    return Buffer.concat(lines, total);
};
