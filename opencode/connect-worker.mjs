import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeApi } from './update-worker.mjs';

const retry = 'e-Comet: connection was not completed. Try /ecomet-connect again.';
const unconfirmed = 'e-Comet: connection is not confirmed. Try /ecomet-connect again.';
const ownServer = (response) => {
    if (!Array.isArray(response?.data)) throw new Error('Invalid native MCP response');
    const matches = response.data.filter((server) => server?.name === 'e-comet');
    if (matches.length !== 1) throw new Error('Missing or ambiguous server');
    return matches[0];
};
const validID = (value) => typeof value === 'string' && value.length > 0 && !/[\x00-\x20\x7f]/.test(value);
const validDeadline = (value) => Number.isFinite(value) && value > 0;
const safeURL = (value) => {
    if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) throw new Error('Invalid OAuth URL');
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('Unsafe OAuth URL');
    return value;
};

export function openOAuthBrowser(url, { platform = process.platform, systemRoot = process.env.SystemRoot, spawnImpl = spawn } = {}) {
    safeURL(url);
    let executable, args;
    if (platform === 'win32') {
        if (!systemRoot) throw new Error('Missing Windows system directory');
        executable = join(systemRoot, 'System32', 'rundll32.exe');
        args = [join(systemRoot, 'System32', 'url.dll') + ',FileProtocolHandler', url];
    } else {
        executable = platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
        args = [url];
    }
    // OAuth query fields remain one argument. No command shell interprets them.
    return new Promise((resolve, reject) => {
        const child = spawnImpl(executable, args, { windowsHide: true, stdio: 'ignore', shell: false });
        const timer = setTimeout(() => { child.kill(); reject(new Error('Browser launcher timeout')); }, 15000);
        child.once('error', () => { clearTimeout(timer); reject(new Error('Browser launch failed')); });
        child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Browser launch failed')); });
    });
}

export async function runConnect({ api, sessionID, pluginID = 'e-comet', openBrowser = openOAuthBrowser, signal, pollIntervalMs = 500, now = Date.now, wait = (ms, signal) => delay(ms, undefined, { signal }) }) {
    let text, owned, complete = false;
    try {
        signal?.throwIfAborted();
        const plugins = (await api('plugin.list'))?.data;
        if (!Array.isArray(plugins) || plugins.filter((plugin) => plugin?.id === pluginID && plugin.state?.status === 'active').length !== 1) throw new Error('Plugin unavailable');
        let server = ownServer(await api('mcp.list'));
        if (['disabled', 'failed'].includes(server.status?.status)) {
            await api('experimental.mcp.connect', undefined, { server: 'e-comet' });
            server = ownServer(await api('mcp.list'));
        }
        if (server.status?.status === 'connected') {
            text = 'e-Comet: already connected.';
        } else if (server.status?.status !== 'needs_auth' || !validID(server.integrationID)) {
            text = unconfirmed;
        } else {
            const integrationID = server.integrationID;
            const integration = (await api('integration.get', undefined, { integrationID }))?.data;
            if (integration?.id !== integrationID || !Array.isArray(integration.methods)) throw new Error('Integration unavailable');
            const methods = integration.methods.filter((method) => method?.type === 'oauth');
            if (methods.length !== 1 || !validID(methods[0].id) || (methods[0].form !== undefined && (!Array.isArray(methods[0].form) || methods[0].form.length))) {
                text = 'e-Comet: this authentication method is not supported by /ecomet-connect. Check OpenCode plugin diagnostics.';
            } else {
                signal?.throwIfAborted();
                // Never retry this mutation: only the native host owns credentials,
                // callback, PKCE and the lifetime of this exact attempt.
                const attempt = (await api('integration.oauth.connect', { methodID: methods[0].id }, { integrationID }))?.data;
                if (!validID(attempt?.attemptID)) throw new Error('Invalid attempt');
                owned = { integrationID, attemptID: attempt.attemptID };
                if (attempt.mode !== 'auto' || !validDeadline(attempt.time?.expires) || attempt.time.expires <= now()) throw new Error('Unsupported attempt');
                safeURL(attempt.url);
                signal?.throwIfAborted();
                try { await openBrowser(attempt.url); }
                catch { text = 'e-Comet: could not open the browser. Check your default browser and try /ecomet-connect again.'; }
                if (!text) {
                    let deadline = attempt.time.expires;
                    while (now() < deadline) {
                        signal?.throwIfAborted();
                        const status = (await api('integration.oauth.status', undefined, owned))?.data;
                        if (!validDeadline(status?.time?.expires)) throw new Error('Invalid status');
                        deadline = Math.min(deadline, status.time.expires);
                        if (status.status === 'complete') { complete = true; break; }
                        if (status.status === 'failed') { text = retry; break; }
                        if (status.status === 'expired') break;
                        if (status.status !== 'pending') throw new Error('Unknown status');
                        const remaining = deadline - now();
                        if (remaining <= 0) break;
                        await wait(Math.min(pollIntervalMs, remaining), signal);
                    }
                    if (complete) {
                        await api('experimental.mcp.connect', undefined, { server: 'e-comet' });
                        text = ownServer(await api('mcp.list')).status?.status === 'connected' ? 'e-Comet: connected.' : unconfirmed;
                    } else if (!text) {
                        text = 'e-Comet: authorization expired. Try /ecomet-connect again.';
                    }
                }
            }
        }
    } catch { text = complete ? unconfirmed : retry; }
    finally {
        // Only our incomplete attempt is cancelled; stored credentials are never
        // read, changed or deleted. Failed cleanup cannot hide the safe outcome.
        if (owned && !complete) await api('integration.oauth.cancel', undefined, owned).catch(() => {});
    }
    await api('session.shell', { command: `echo "${text}"` }, { sessionID });
    await api('session.synthetic', {
        text: `ECOMET_CONNECT_RESULT\n${text}\nСообщи пользователю только этот готовый результат по-русски одним коротким предложением. Connected означает только подключение аккаунта e-Comet; не заявляй готовность других операций. Не вызывай инструменты, не делай новых проверок и ничего не изменяй.`,
        resume: true,
    }, { sessionID }).catch(() => {});
    return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { directory, sessionID, pluginID } = JSON.parse(process.argv[2]);
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    try { await runConnect({ api: createNativeApi({ directory }), sessionID, pluginID, signal: controller.signal }); }
    finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
