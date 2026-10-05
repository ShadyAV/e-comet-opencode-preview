import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const target = '@avshady/e-comet-opencode@preview';
const validVersion = (value) => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?(?:\+[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(value);
const ownPlugin = (response, pluginID) => {
    if (!Array.isArray(response?.data)) throw new Error('Invalid native plugin response');
    const matches = response.data.filter((plugin) => plugin?.id === pluginID);
    if (matches.length !== 1) throw new Error('Missing or ambiguous plugin');
    return matches[0];
};
const supported = (plugin) => plugin.source?.type === 'package' && plugin.source.target === target && validVersion(plugin.source.version) && plugin.state?.status === 'active';
const compareVersions = (left, right) => {
    const parts = (value) => /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/.exec(value);
    const a = parts(left), b = parts(right);
    for (let index = 1; index <= 3; index++) {
        if (BigInt(a[index]) !== BigInt(b[index])) return BigInt(a[index]) > BigInt(b[index]) ? 1 : -1;
    }
    if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
    const x = a[4].split('.'), y = b[4].split('.');
    for (let index = 0; index < Math.max(x.length, y.length); index++) {
        if (x[index] === y[index]) continue;
        if (x[index] === undefined || y[index] === undefined) return x[index] === undefined ? -1 : 1;
        const nx = /^\d+$/.test(x[index]), ny = /^\d+$/.test(y[index]);
        if (nx && ny) {
            if (BigInt(x[index]) === BigInt(y[index])) continue;
            return BigInt(x[index]) > BigInt(y[index]) ? 1 : -1;
        }
        if (nx !== ny) return nx ? -1 : 1;
        return x[index] > y[index] ? 1 : -1;
    }
    return 0;
};

export function createNativeApi({ executable = process.execPath, executableArgs = [], directory }) {
    const env = { ...process.env };
    // The same installed executable runs this JS helper and the native CLI.
    // Bun mode belongs only to the helper, never to CLI API calls.
    delete env.BUN_BE_BUN;
    return async (operation, data, params = {}) => {
        const args = [...executableArgs, 'api', operation, '--header', 'x-opencode-directory:' + encodeURIComponent(directory)];
        for (const [key, value] of Object.entries(params)) args.push('--param', `${key}=${value}`);
        if (data !== undefined) args.push('--data', JSON.stringify(data));
        const { stdout } = await execute(executable, args, { cwd: directory, env, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
        return stdout.trim() ? JSON.parse(stdout) : null;
    };
}

export async function runUpdate({ api, sessionID, pluginID = 'e-comet', registryFetch = globalThis.fetch, activationTimeoutMs = 60000, pollIntervalMs = 1000 }) {
    let text;
    let stage = 'check';
    try {
        const installed = ownPlugin(await api('plugin.list'), pluginID);
        if (!supported(installed)) {
            text = 'e-Comet: this installation cannot update automatically. Install @avshady/e-comet-opencode@preview through OpenCode.';
        } else {
            if (installed.source.updating) throw new Error('Already updating');
            // OpenCode 2.0.22 swallows npm.check failures and can return outdated=false.
            // A single read-only official lookup is required for a truthful check;
            // package resolution, downloads and activation remain native operations.
            const response = await registryFetch('https://registry.npmjs.org/@avshady%2fe-comet-opencode/preview', { signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw new Error('Registry request failed');
            const advertised = await response.json();
            if (advertised?.name !== '@avshady/e-comet-opencode' || !validVersion(advertised.version)) throw new Error('Invalid registry metadata');
            const comparison = compareVersions(installed.source.version, advertised.version);
            if (!comparison) {
                text = `e-Comet: up to date (${installed.source.version})`;
            } else if (comparison > 0) {
                text = `e-Comet: installed ${installed.source.version} is newer than the preview channel (${advertised.version}). No update applied.`;
            } else {
                stage = 'update';
                await api('plugin.update', { targets: [target] });
                stage = 'activation';
                const deadline = Date.now() + activationTimeoutMs;
                do {
                    // Read-only polling may span the host temporarily unloading its
                    // own package. Never retry plugin.update or result delivery.
                    let active;
                    try { active = ownPlugin(await api('plugin.list'), pluginID); }
                    catch { await delay(pollIntervalMs); continue; }
                    if (supported(active) && !active.source.updating && active.source.version === advertised.version) {
                        text = `e-Comet updated: ${installed.source.version} -> ${active.source.version}`;
                        break;
                    }
                    if (active.state?.status === 'failed') throw new Error('Activation failed');
                    await delay(pollIntervalMs);
                } while (Date.now() < deadline);
                if (!text) throw new Error('Activation timeout');
            }
        }
    } catch {
        text = stage === 'check'
            ? 'e-Comet: could not check for updates. Check the OpenCode connection and try /ecomet-update again.'
            : stage === 'update'
                ? 'e-Comet: could not update. Check OpenCode plugin diagnostics before trying again.'
                : 'e-Comet: update activation is not confirmed. Check OpenCode plugin diagnostics.';
    }
    // Output contains only fixed ASCII text and strictly validated versions;
    // shell metadata must never include raw native errors, paths or credentials.
    await api('session.shell', { command: `echo "${text}"` }, { sessionID });
    // The selected model only displays the trusted completed result. Its failure
    // cannot repeat the native update; the durable shell result remains available.
    await api('session.synthetic', {
        text: `ECOMET_UPDATE_RESULT\n${text}\nСообщи пользователю только этот результат. Не вызывай инструменты и ничего не изменяй.`,
        resume: true,
    }, { sessionID }).catch(() => {});
    return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { directory, sessionID, pluginID } = JSON.parse(process.argv[2]);
    await runUpdate({ api: createNativeApi({ directory }), sessionID, pluginID });
}
