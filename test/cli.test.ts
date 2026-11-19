import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGateway, parseConfig, startFromConfig, type GatewayConfig } from '../src/index.js';
import { eventually, toolNames } from './helpers.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const shopServer = fileURLToPath(new URL('../examples/shop/shop-server.mjs', import.meta.url));

let dir: string;
const open: Array<{ close(): Promise<unknown> }> = [];
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-effect-'));
});
afterEach(async () => {
    await Promise.allSettled(open.splice(0).map(item => item.close()));
    await rm(dir, { recursive: true, force: true });
});

function shopConfig(extra: Partial<GatewayConfig> = {}): GatewayConfig {
    return {
        name: 'shop-gateway',
        upstreams: { shop: { command: process.execPath, args: [shopServer] } },
        always: ['shop__get_order'],
        rules: [
            {
                name: 'refunds',
                when: { 'order.status': 'failed' },
                tools: ['shop__refund_order', 'shop__email_customer'],
                hint: 'Refund tools appear when an order has failed.'
            }
        ],
        ...extra
    };
}

describe('config', () => {
    it('accepts a full config and fills in environment variables', () => {
        const config = parseConfig(
            {
                upstreams: {
                    remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${API_KEY}' } },
                    local: { command: 'node', args: ['${SERVER}'], env: { KEY: '${API_KEY}' } }
                },
                always: ['a'],
                rules: [{ when: { x: 1 }, tools: ['b'] }],
                state: { initial: { x: 0 }, scopes: { s: {} }, file: './state.json' },
                http: { port: 0, clients: [{ tokenEnv: 'T', scope: 's' }], adminTokenEnv: 'A' }
            },
            { API_KEY: 'secret', SERVER: 'server.js' }
        );
        expect(config.upstreams!.remote).toEqual({ url: 'https://example.com/mcp', headers: { Authorization: 'Bearer secret' } });
        expect(config.upstreams!.local).toEqual({ command: 'node', args: ['server.js'], env: { KEY: 'secret' } });
    });

    it.each([
        [[], /JSON object/],
        [{ nope: 1 }, /unknown field "nope"/],
        [{ denied: 'maybe' }, /denied/],
        [{ upstreams: { x: {} } }, /upstreams\.x needs either/],
        [{ upstreams: { x: { url: '${MISSING}' } } }, /MISSING/],
        [{ always: [1] }, /always/],
        [{ rules: [{ tools: 'x' }] }, /rules\[0\]\.tools/],
        [{ rules: [{ tools: ['x'], extra: 1 }] }, /unknown field "extra"/],
        [{ rules: [{ tools: ['x'], when: [] }] }, /when/],
        [{ state: { initial: [] } }, /state\.initial/],
        [{ http: { port: 70000 } }, /http\.port/],
        [{ http: { path: 'mcp' } }, /http\.path/],
        [{ http: { clients: [{}] } }, /tokenEnv/]
    ])('rejects %j with a clear message', (raw, message) => {
        expect(() => parseConfig(raw, {})).toThrow(message);
    });
});

describe('the mcp-effect command over stdio', () => {
    it('prints help, checks a config, and fails clearly on a bad one', async () => {
        expect((await run(process.execPath, [cli, '--help'])).stdout).toContain('Usage:');
        const good = join(dir, 'good.json');
        await writeFile(good, JSON.stringify(shopConfig()));
        expect((await run(process.execPath, [cli, good, '--check'])).stdout).toContain('config ok');
        const bad = join(dir, 'bad.json');
        await writeFile(bad, '{"rules": 5}');
        await expect(run(process.execPath, [cli, bad, '--check'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('rules must be an array') });
        await expect(run(process.execPath, [cli, join(dir, 'missing.json')])).rejects.toMatchObject({ code: 1 });
    });

    it('gates a real upstream server and follows a state file that any program can write', async () => {
        const stateFile = join(dir, 'state.json');
        await writeFile(stateFile, JSON.stringify({ global: { order: { status: 'paid' } } }));
        const configFile = join(dir, 'gateway.json');
        await writeFile(configFile, JSON.stringify(shopConfig({ state: { file: './state.json' } })));

        const client = new Client({ name: 'cli-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, configFile], stderr: 'ignore' }));
        open.push(client);

        expect(await toolNames(client)).toEqual(['shop__get_order']);
        const read = await client.callTool({ name: 'shop__get_order', arguments: { orderId: '42' } });
        expect(JSON.stringify(read.content)).toContain('Order 42');
        await expect(client.callTool({ name: 'shop__refund_order', arguments: { orderId: '42' } })).rejects.toThrow(/Unknown tool/);

        await writeFile(stateFile, JSON.stringify({ global: { order: { status: 'failed' } } }));
        await eventually(async () => expect(await toolNames(client)).toEqual(['shop__email_customer', 'shop__get_order', 'shop__refund_order']), 5000);
        const refund = await client.callTool({ name: 'shop__refund_order', arguments: { orderId: '42' } });
        expect(JSON.stringify(refund.content)).toContain('Refunded order 42');

        // A half-written file must not change anything.
        await writeFile(stateFile, '{"global": {"order": ');
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(await toolNames(client)).toContain('shop__refund_order');

        await writeFile(stateFile, JSON.stringify({ global: {} }));
        await eventually(async () => expect(await toolNames(client)).toEqual(['shop__get_order']), 5000);
    });
});

describe('the mcp-effect command over HTTP', () => {
    const env = { ALICE_TOKEN: 'alice-secret', BOB_TOKEN: 'bob-secret', ADMIN_TOKEN: 'admin-secret', PATH: process.env.PATH };

    async function start(http: GatewayConfig['http'] = {}) {
        const running = await startFromConfig(
            shopConfig({
                http: {
                    port: 0,
                    clients: [
                        { tokenEnv: 'ALICE_TOKEN', scope: 'user:alice' },
                        { tokenEnv: 'BOB_TOKEN', scope: 'user:bob' }
                    ],
                    adminTokenEnv: 'ADMIN_TOKEN',
                    ...http
                }
            }),
            { mode: 'http', env, log: () => {} }
        );
        open.push(running);
        return running;
    }

    async function connect(port: number, token?: string): Promise<Client> {
        const client = new Client({ name: 'http-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined)
        );
        open.push(client);
        return client;
    }

    const admin = (port: number, scope: string, method: string, body?: unknown, token = 'admin-secret') =>
        fetch(`http://127.0.0.1:${port}/state/${encodeURIComponent(scope)}`, {
            method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });

    it('needs a known token, and gives each token its own scope', async () => {
        const { port } = await start();
        const noToken = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
        expect(noToken.status).toBe(401);
        const wrong = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            body: '{}',
            headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }
        });
        expect(wrong.status).toBe(401);

        const alice = await connect(port!, 'alice-secret');
        const bob = await connect(port!, 'bob-secret');
        expect(await toolNames(alice)).toEqual(['shop__get_order']);

        const patched = await admin(port!, 'user:alice', 'PATCH', { order: { status: 'failed' } });
        expect(patched.status).toBe(200);
        expect(((await patched.json()) as { tools: string[] }).tools).toEqual(['shop__email_customer', 'shop__get_order', 'shop__refund_order']);

        expect(await toolNames(alice)).toContain('shop__refund_order');
        expect(await toolNames(bob)).toEqual(['shop__get_order']);
        const refund = await alice.callTool({ name: 'shop__refund_order', arguments: { orderId: '9' } });
        expect(JSON.stringify(refund.content)).toContain('Refunded order 9');
        await expect(bob.callTool({ name: 'shop__refund_order', arguments: { orderId: '9' } })).rejects.toThrow(/Unknown tool/);
    });

    it('protects the state API', async () => {
        const { port } = await start();
        expect((await admin(port!, 'global', 'GET', undefined, 'wrong')).status).toBe(401);
        expect((await admin(port!, 'global', 'GET', undefined, 'alice-secret')).status).toBe(401);
        expect((await admin(port!, 'global', 'DELETE')).status).toBe(405);
        expect((await admin(port!, 'global', 'PATCH', [1, 2])).status).toBe(400);
        const bad = await fetch(`http://127.0.0.1:${port}/state/global`, { method: 'PATCH', headers: { authorization: 'Bearer admin-secret' }, body: '{oops' });
        expect(bad.status).toBe(400);
        const big = await fetch(`http://127.0.0.1:${port}/state/global`, {
            method: 'PATCH',
            headers: { authorization: 'Bearer admin-secret' },
            body: JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 10) })
        });
        expect(big.status).toBe(413);

        expect((await admin(port!, 'global', 'PUT', { order: { status: 'failed' } })).status).toBe(200);
        const read = (await (await admin(port!, "global", "GET")).json()) as { state: unknown };
        expect(read.state).toEqual({ order: { status: 'failed' } });
        expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
        expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    });

    it('has no state API at all when no admin token is configured', async () => {
        const { port } = await start({ adminTokenEnv: undefined });
        expect((await admin(port!, 'global', 'GET')).status).toBe(404);
    });

    it('refuses a request with a foreign Host header (DNS rebinding guard)', async () => {
        const { port } = await start();
        const status = await new Promise<number>((resolve, reject) => {
            const req = request({ host: '127.0.0.1', port, path: '/healthz', headers: { host: 'evil.example' } }, res => {
                res.resume();
                resolve(res.statusCode ?? 0);
            });
            req.on('error', reject);
            req.end();
        });
        expect(status).toBe(403);
    });

    it('will not start open to the network without tokens, or with a missing token variable', async () => {
        await expect(startFromConfig(shopConfig({ http: { port: 0, host: '0.0.0.0' } }), { mode: 'http', env, log: () => {} })).rejects.toThrow(/http\.clients is required/);
        await expect(
            startFromConfig(shopConfig({ http: { port: 0, host: '0.0.0.0', clients: [{ tokenEnv: 'ALICE_TOKEN' }] } }), { mode: 'http', env, log: () => {} })
        ).rejects.toThrow(/allowedHosts/);
        await expect(startFromConfig(shopConfig({ http: { port: 0, clients: [{ tokenEnv: 'NOT_SET' }] } }), { mode: 'http', env, log: () => {} })).rejects.toThrow(/NOT_SET/);
    });

    it('also serves a 2025-era client over HTTP', async () => {
        const { port } = await start();
        const client = new Client({ name: 'legacy-http', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer alice-secret' } } })
        );
        open.push(client);
        expect(client.getDiscoverResult()).toBeUndefined();
        expect(await toolNames(client)).toEqual(['shop__get_order']);
        await admin(port!, 'user:alice', 'PATCH', { order: { status: 'failed' } });
        expect(await toolNames(client)).toContain('shop__refund_order');
        await admin(port!, 'user:alice', 'PUT', {});
        await expect(client.callTool({ name: 'shop__refund_order', arguments: { orderId: '1' } })).rejects.toThrow(/Unknown tool/);
    });
});

describe('a remote upstream over HTTP', () => {
    it('sends the configured headers and follows the upstream when its tools change', async () => {
        const tools = [{ name: 'alpha', inputSchema: { type: 'object' as const } }];
        const seenAuth: Array<string | undefined> = [];
        const upstream = createMcpHandler(() => {
            const server = new Server({ name: 'dynamic', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
            server.setRequestHandler('tools/list', async () => ({ tools }));
            server.setRequestHandler('tools/call', async request => ({ content: [{ type: 'text', text: `ran ${request.params.name}` }] }));
            return server;
        });
        const node = toNodeHandler(upstream);
        const http = createServer((req, res) => {
            seenAuth.push(req.headers.authorization);
            void node(req, res);
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const port = (http.address() as AddressInfo).port;
        open.push({
            close: async () => {
                await upstream.close();
                http.closeAllConnections();
                await new Promise(resolve => http.close(resolve));
            }
        });

        const gateway = createGateway({ always: ['remote__*'], notifyDebounceMs: 5 });
        open.unshift(gateway);
        await gateway.upstream('remote', { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer upstream-key' } });

        expect(await gateway.mounted()).toEqual(['remote__alpha']);
        expect(seenAuth.every(value => value === 'Bearer upstream-key')).toBe(true);
        const result = await gateway.callTool(undefined, 'remote__alpha');
        expect(JSON.stringify(result.content)).toContain('ran alpha');

        tools.push({ name: 'beta', inputSchema: { type: 'object' as const } });
        upstream.notify.toolsChanged();
        await eventually(async () => expect(await gateway.mounted()).toEqual(['remote__alpha', 'remote__beta']), 5000);
    });

    it('fails with a clear message when the upstream cannot be reached', async () => {
        const gateway = createGateway();
        open.push(gateway);
        await expect(gateway.upstream('down', { url: 'http://127.0.0.1:9/mcp' })).rejects.toThrow();
        await expect(gateway.upstream('bad', { url: 'not a url' })).rejects.toThrow(/not a valid URL/);
        await expect(gateway.upstream('ftp', { url: 'ftp://example.com/mcp' })).rejects.toThrow(/http or https/);
        await expect(gateway.upstream('empty', {} as never)).rejects.toThrow(/either "command" or "url"/);
        expect(gateway.registeredTools()).toEqual([]);
    });
});
