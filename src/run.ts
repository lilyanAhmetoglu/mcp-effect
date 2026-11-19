import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { hostHeaderValidation, localhostHostValidation, localhostOriginValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { AuthInfo } from '@modelcontextprotocol/server';

import type { GatewayConfig } from './config.js';
import { createGateway, type Gateway } from './gateway.js';
import { GLOBAL_SCOPE, type State } from './state.js';

export interface RunningGateway {
    gateway: Gateway;
    /** The HTTP port in use, in `http` mode. */
    port?: number;
    close(): Promise<void>;
}

export interface StartOptions {
    mode: 'stdio' | 'http';
    /** Folder that relative paths in the config start from. Default: the current folder. */
    baseDir?: string;
    /** Where log lines go. Default: stderr. Never stdout, because stdio mode speaks MCP there. */
    log?: (line: string) => void;
    env?: NodeJS.ProcessEnv;
}

const MAX_ADMIN_BODY = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function sameSecret(given: string, expected: string): boolean {
    // Hash first so both sides have one length and the compare leaks no timing.
    const a = createHash('sha256').update(given).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match?.[1];
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += buffer.length;
        if (size > MAX_ADMIN_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
        chunks.push(buffer);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw Object.assign(new Error('body is not valid JSON'), { status: 400 });
    }
}

/** Builds a gateway from a config and starts serving. This is what the CLI runs. */
export async function startFromConfig(config: GatewayConfig, options: StartOptions): Promise<RunningGateway> {
    const log = options.log ?? (line => process.stderr.write(`${line}\n`));
    const env = options.env ?? process.env;
    const baseDir = options.baseDir ?? process.cwd();
    const cleanups: Array<() => void | Promise<void>> = [];

    const gateway = createGateway({
        name: config.name,
        version: config.version,
        separator: config.separator,
        denied: config.denied,
        instructions: config.instructions,
        always: config.always,
        rules: config.rules,
        initialState: config.state?.initial,
        // HTTP callers get the scope of their token. stdio has one caller: the fixed scope.
        scope: ({ authInfo }) => (authInfo ? (authInfo.extra?.mcpEffectScope as string | undefined) : config.scope),
        onerror: error => log(`[mcp-effect] ${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ''}`)
    });

    try {
        for (const [scope, state] of Object.entries(config.state?.scopes ?? {})) {
            await gateway.replaceState(state, { scope });
        }

        if (config.state?.file) {
            const file = resolve(baseDir, config.state.file);
            // The file is the source of truth, so scopes from the config go away unless the file lists them.
            let knownScopes = new Set<string>(Object.keys(config.state.scopes ?? {}));
            const load = (): void => {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(readFileSync(file, 'utf8'));
                } catch (error) {
                    // Keep the last good state. A half-written file must not open or close tools.
                    log(`[mcp-effect] state file ${file} not applied: ${(error as Error).message}`);
                    return;
                }
                if (!isObject(parsed)) {
                    log(`[mcp-effect] state file ${file} not applied: it must contain a JSON object`);
                    return;
                }
                const globalState = isObject(parsed.global) ? parsed.global : {};
                const scopes = isObject(parsed.scopes) ? parsed.scopes : {};
                void (async () => {
                    await gateway.replaceState(globalState as State);
                    const next = new Set<string>();
                    for (const [scope, state] of Object.entries(scopes)) {
                        if (scope === GLOBAL_SCOPE || !isObject(state)) continue;
                        next.add(scope);
                        await gateway.replaceState(state as State, { scope });
                    }
                    for (const scope of knownScopes) {
                        if (!next.has(scope)) await gateway.replaceState({}, { scope });
                    }
                    knownScopes = next;
                })().catch(error => log(`[mcp-effect] state file ${file} not applied: ${(error as Error).message}`));
            };
            load();
            watchFile(file, { interval: 200 }, load);
            cleanups.push(() => unwatchFile(file, load));
        }

        for (const [name, upstream] of Object.entries(config.upstreams ?? {})) {
            const target = 'command' in upstream && upstream.cwd === undefined ? { ...upstream, cwd: baseDir } : upstream;
            await gateway.upstream(name, target);
        }

        if (options.mode === 'stdio') {
            gateway.stdio();
            log(`[mcp-effect] serving over stdio with ${gateway.registeredTools().length} registered tools`);
            return { gateway, close: () => shutdown(gateway, cleanups) };
        }

        const http = config.http ?? {};
        const host = http.host ?? '127.0.0.1';
        const path = http.path ?? '/mcp';
        const clients = (http.clients ?? []).map(client => {
            const token = env[client.tokenEnv];
            if (!token) throw new Error(`mcp-effect config: environment variable ${client.tokenEnv} (http.clients) is not set`);
            return { token, scope: client.scope };
        });
        const adminToken = http.adminTokenEnv ? env[http.adminTokenEnv] : undefined;
        if (http.adminTokenEnv && !adminToken) throw new Error(`mcp-effect config: environment variable ${http.adminTokenEnv} (http.adminTokenEnv) is not set`);
        if (!LOOPBACK.has(host) && clients.length === 0) {
            throw new Error('mcp-effect config: http.clients is required when http.host is not loopback, so the endpoint is never open to the network');
        }
        if (!LOOPBACK.has(host) && !http.allowedHosts?.length) {
            throw new Error('mcp-effect config: http.allowedHosts is required when http.host is not loopback');
        }

        const validateHost = http.allowedHosts?.length ? hostHeaderValidation(http.allowedHosts) : localhostHostValidation();
        const validateOrigin = http.allowedHosts?.length ? originValidation(http.allowedHosts) : localhostOriginValidation();
        const mcp = toNodeHandler(gateway.http(), { onerror: error => log(`[mcp-effect] ${error.message}`) });

        const server: HttpServer = createServer((req, res) => {
            void (async () => {
                if (!validateHost(req, res) || !validateOrigin(req, res)) return;
                const url = new URL(req.url ?? '/', 'http://gateway.local');

                if (url.pathname === '/healthz' && req.method === 'GET') {
                    sendJson(res, 200, { ok: true });
                    return;
                }

                if (url.pathname === path) {
                    if (clients.length > 0) {
                        const given = bearer(req);
                        // Check every client so timing does not reveal which token matched.
                        let found: (typeof clients)[number] | undefined;
                        for (const client of clients) {
                            if (given !== undefined && sameSecret(given, client.token)) found = client;
                        }
                        if (!found || given === undefined) {
                            sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
                            return;
                        }
                        const auth: AuthInfo = {
                            token: given,
                            clientId: found.scope ?? 'anonymous',
                            scopes: [],
                            extra: { mcpEffectScope: found.scope }
                        };
                        (req as IncomingMessage & { auth?: AuthInfo }).auth = auth;
                    }
                    await mcp(req as never, res as never);
                    return;
                }

                if (url.pathname.startsWith('/state/')) {
                    if (!adminToken) {
                        sendJson(res, 404, { error: 'not found' });
                        return;
                    }
                    const given = bearer(req);
                    if (given === undefined || !sameSecret(given, adminToken)) {
                        sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
                        return;
                    }
                    let scope: string;
                    try {
                        scope = decodeURIComponent(url.pathname.slice('/state/'.length));
                    } catch {
                        sendJson(res, 400, { error: 'bad scope' });
                        return;
                    }
                    if (scope.length === 0) {
                        sendJson(res, 400, { error: 'scope is required, use "global" for the shared state' });
                        return;
                    }
                    if (req.method === 'GET') {
                        sendJson(res, 200, { scope, state: await gateway.store.get(scope), tools: await gateway.mounted(scope === GLOBAL_SCOPE ? undefined : scope) });
                        return;
                    }
                    if (req.method === 'PATCH' || req.method === 'PUT') {
                        const body = await readJson(req);
                        if (!isObject(body)) {
                            sendJson(res, 400, { error: 'body must be a JSON object' });
                            return;
                        }
                        if (req.method === 'PATCH') await gateway.setState(body, { scope });
                        else await gateway.replaceState(body, { scope });
                        await gateway.flush();
                        sendJson(res, 200, { scope, state: await gateway.store.get(scope), tools: await gateway.mounted(scope === GLOBAL_SCOPE ? undefined : scope) });
                        return;
                    }
                    sendJson(res, 405, { error: 'use GET, PATCH or PUT' }, { allow: 'GET, PATCH, PUT' });
                    return;
                }

                sendJson(res, 404, { error: 'not found' });
            })().catch((error: Error & { status?: number }) => {
                if (!res.headersSent) sendJson(res, error.status ?? 500, { error: error.status ? error.message : 'internal error' });
                else res.end();
                if (!error.status) log(`[mcp-effect] ${error.message}`);
            });
        });

        await new Promise<void>((resolveListen, rejectListen) => {
            server.once('error', rejectListen);
            server.listen(http.port ?? 3000, host, () => {
                server.off('error', rejectListen);
                resolveListen();
            });
        });
        const port = (server.address() as AddressInfo).port;
        cleanups.push(
            () =>
                new Promise<void>(done => {
                    server.close(() => done());
                    server.closeAllConnections();
                })
        );
        log(`[mcp-effect] serving on http://${host}:${port}${path} with ${gateway.registeredTools().length} registered tools`);
        return { gateway, port, close: () => shutdown(gateway, cleanups) };
    } catch (error) {
        await shutdown(gateway, cleanups);
        throw error;
    }
}

async function shutdown(gateway: Gateway, cleanups: Array<() => void | Promise<void>>): Promise<void> {
    // Close the gateway first: it ends open subscription streams so the HTTP server can stop.
    await gateway.close();
    for (const cleanup of cleanups.splice(0).reverse()) {
        try {
            await cleanup();
        } catch {
            // Keep shutting down.
        }
    }
}
