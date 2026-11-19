import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGateway, getPath, type ChangeEvent, type Gateway, type StateStore, type State, type UpstreamClient } from '../src/index.js';
import { auth, connectModern, eventually, text, toolNames } from './helpers.js';

const open: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
    await Promise.allSettled(open.splice(0).map(item => item.close()));
});

function shop(options: Parameters<typeof createGateway>[0] = {}): Gateway {
    const gateway = createGateway({
        always: ['get_order'],
        scope: ({ authInfo }) => authInfo?.clientId,
        ...options
    });
    gateway.tool({ name: 'get_order', description: 'Read an order' }, async args => text(`order ${String(args.id)}`));
    gateway.tool({ name: 'refund_order', description: 'Refund an order' }, async (args, ctx) => text(`refunded ${String(args.id)} for ${ctx.scope}`));
    gateway.tool({ name: 'email_customer', description: 'Email the customer' }, async () => text('sent'));
    gateway.useTools({
        name: 'refunds',
        deps: ['order.status'],
        tools: state => (getPath(state, 'order.status') === 'failed' ? ['refund_order', 'email_customer'] : []),
        hint: 'Refund tools appear when an order has failed.'
    });
    open.push(gateway);
    return gateway;
}

describe('mounting', () => {
    it('shows only the always-mounted tools at first', async () => {
        const gateway = shop();
        const client = await connectModern(gateway.http(), auth('user:alice'));
        open.push(client);
        expect(await toolNames(client)).toEqual(['get_order']);
    });

    it('mounts tools when state changes and unmounts them when it changes back', async () => {
        const gateway = shop();
        const client = await connectModern(gateway.http(), auth('user:alice'));
        open.push(client);

        await gateway.setState({ order: { status: 'failed' } }, { scope: 'user:alice' });
        expect(await toolNames(client)).toEqual(['email_customer', 'get_order', 'refund_order']);

        await gateway.setState({ order: { status: 'paid' } }, { scope: 'user:alice' });
        expect(await toolNames(client)).toEqual(['get_order']);
    });

    it('returns tools in the same sorted order every time', async () => {
        const gateway = shop({ always: ['*'] });
        const client = await connectModern(gateway.http());
        open.push(client);
        const first = await toolNames(client);
        expect(first).toEqual([...first].sort());
        expect(await toolNames(client)).toEqual(first);
    });

    it('keeps scopes apart: one caller never sees tools mounted for another', async () => {
        const gateway = shop();
        const handler = gateway.http();
        const alice = await connectModern(handler, auth('user:alice'));
        const bob = await connectModern(handler, auth('user:bob'));
        const nobody = await connectModern(handler);
        open.push(alice, bob, nobody);

        await gateway.setState({ order: { status: 'failed' } }, { scope: 'user:alice' });

        expect(await toolNames(alice)).toContain('refund_order');
        expect(await toolNames(bob)).toEqual(['get_order']);
        expect(await toolNames(nobody)).toEqual(['get_order']);
    });

    it('lets global state reach every scope, and scope state win over it', async () => {
        const gateway = shop();
        const handler = gateway.http();
        const alice = await connectModern(handler, auth('user:alice'));
        const bob = await connectModern(handler, auth('user:bob'));
        open.push(alice, bob);

        await gateway.setState({ order: { status: 'failed' } });
        await gateway.setState({ order: { status: 'paid' } }, { scope: 'user:bob' });

        expect(await toolNames(alice)).toContain('refund_order');
        expect(await toolNames(bob)).toEqual(['get_order']);
        expect(await gateway.getState('user:bob')).toEqual({ order: { status: 'paid' } });
    });

    it('supports rules written as data, with wildcards', async () => {
        const gateway = createGateway({
            rules: [{ when: { plan: { in: ['pro', 'team'] } }, tools: ['report_*'] }]
        });
        open.push(gateway);
        gateway.tool({ name: 'report_sales' }, async () => text('sales'));
        gateway.tool({ name: 'report_costs' }, async () => text('costs'));
        gateway.tool({ name: 'other' }, async () => text('other'));

        expect(await gateway.mounted()).toEqual([]);
        await gateway.setState({ plan: 'pro' });
        expect(await gateway.mounted()).toEqual(['report_costs', 'report_sales']);
        await gateway.setState({ plan: null });
        expect(await gateway.mounted()).toEqual([]);
    });

    it('mounts nothing when a rule throws', async () => {
        const onerror = vi.fn();
        const gateway = shop({ onerror });
        gateway.useTools({
            name: 'broken',
            tools: () => {
                throw new Error('boom');
            }
        });
        expect(await gateway.mounted('user:alice')).toEqual(['get_order']);
        expect(onerror).toHaveBeenCalled();
    });

    it('puts rule hints into the server instructions', async () => {
        const gateway = shop({ instructions: 'Shop gateway.' });
        const client = await connectModern(gateway.http());
        open.push(client);
        const instructions = client.getInstructions();
        expect(instructions).toContain('Shop gateway.');
        expect(instructions).toContain('Refund tools appear when an order has failed.');
    });
});

describe('enforcement at call time', () => {
    it('runs a mounted tool and passes scope and state to the handler', async () => {
        const gateway = shop();
        const client = await connectModern(gateway.http(), auth('user:alice'));
        open.push(client);
        await gateway.setState({ order: { status: 'failed' } }, { scope: 'user:alice' });
        const result = await client.callTool({ name: 'refund_order', arguments: { id: '42' } });
        expect(result.content).toEqual([{ type: 'text', text: 'refunded 42 for user:alice' }]);
    });

    it('refuses an unmounted tool exactly like a tool that does not exist', async () => {
        const gateway = shop();
        const client = await connectModern(gateway.http(), auth('user:alice'));
        open.push(client);

        const hidden = await client.callTool({ name: 'refund_order', arguments: { id: '42' } }).catch(error => error);
        const missing = await client.callTool({ name: 'no_such_tool', arguments: {} }).catch(error => error);

        expect(hidden).toBeInstanceOf(Error);
        expect(missing).toBeInstanceOf(Error);
        expect(hidden.code).toBe(-32602);
        expect(hidden.code).toBe(missing.code);
        expect(hidden.message.replace('refund_order', 'X')).toBe(missing.message.replace('no_such_tool', 'X'));
    });

    it('refuses a client that still holds an old tool list', async () => {
        const gateway = shop();
        const client = await connectModern(gateway.http(), auth('user:alice'));
        open.push(client);
        await gateway.setState({ order: { status: 'failed' } }, { scope: 'user:alice' });
        expect(await toolNames(client)).toContain('refund_order');

        await gateway.setState({ order: { status: 'refunded' } }, { scope: 'user:alice' });
        // The client does not list again. It calls from its old list.
        await expect(client.callTool({ name: 'refund_order', arguments: { id: '42' } })).rejects.toThrow(/Unknown tool/);
    });

    it('does not let one scope call a tool that is mounted for another', async () => {
        const gateway = shop();
        const handler = gateway.http();
        const bob = await connectModern(handler, auth('user:bob'));
        open.push(bob);
        await gateway.setState({ order: { status: 'failed' } }, { scope: 'user:alice' });
        await expect(bob.callTool({ name: 'refund_order', arguments: { id: '1' } })).rejects.toThrow(/Unknown tool/);
    });

    it('can explain the refusal to the model instead, when asked to', async () => {
        const gateway = shop({ denied: 'explain' });
        const client = await connectModern(gateway.http(), auth('user:alice'));
        open.push(client);
        const result = await client.callTool({ name: 'refund_order', arguments: { id: '42' } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('not available right now');
        expect(JSON.stringify(result.content)).toContain('Refund tools appear when an order has failed.');
        // A tool that truly does not exist is still a protocol error.
        await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(/Unknown tool/);
    });

    it('turns a throwing tool handler into an error for the client, not a crash', async () => {
        const gateway = shop({ always: ['*'] });
        gateway.tool({ name: 'explode' }, async () => {
            throw new Error('kaboom');
        });
        const client = await connectModern(gateway.http());
        open.push(client);
        await expect(client.callTool({ name: 'explode', arguments: {} })).rejects.toThrow();
        expect(await toolNames(client)).toContain('get_order');
    });
});

describe('change notifications', () => {
    it('tells a subscribed 2026-07-28 client that the list changed', async () => {
        const gateway = shop({ notifyDebounceMs: 5 });
        const onChanged = vi.fn();
        const client = await connectModern(gateway.http(), auth('user:alice'), { listChanged: { tools: { onChanged } } });
        open.push(client);
        await toolNames(client);

        await gateway.setState({ order: { status: 'failed' } }, { scope: 'user:alice' });

        await eventually(() => expect(onChanged).toHaveBeenCalled());
        const [error, tools] = onChanged.mock.calls.at(-1)!;
        expect(error).toBeNull();
        expect(tools.map((tool: { name: string }) => tool.name)).toContain('refund_order');
    });

    it('groups a burst of state writes into very few notifications', async () => {
        const gateway = shop({ notifyDebounceMs: 20 });
        const notified = vi.fn();
        const client = await connectModern(gateway.http(), auth('user:alice'));
        open.push(client);
        client.setNotificationHandler('notifications/tools/list_changed', async () => notified());
        await client.listen({ toolsListChanged: true });
        await toolNames(client);

        for (let i = 0; i < 200; i++) {
            await gateway.setState({ order: { status: i % 2 === 0 ? 'failed' : 'paid' }, tick: i }, { scope: 'user:alice' });
        }
        await gateway.setState({ order: { status: 'failed' } }, { scope: 'user:alice' });
        await gateway.flush();

        await eventually(() => expect(notified).toHaveBeenCalled());
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(notified.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('sends nothing when state changes but the tool list stays the same', async () => {
        const gateway = shop({ notifyDebounceMs: 5 });
        const notified = vi.fn();
        const client = await connectModern(gateway.http(), auth('user:alice'));
        open.push(client);
        client.setNotificationHandler('notifications/tools/list_changed', async () => notified());
        await client.listen({ toolsListChanged: true });
        await toolNames(client);

        await gateway.setState({ unrelated: 1 }, { scope: 'user:alice' });
        await gateway.flush();
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(notified).not.toHaveBeenCalled();
    });

    it('emits change events with what was mounted and unmounted', async () => {
        const gateway = shop();
        const events: ChangeEvent[] = [];
        gateway.on('change', event => events.push(event));
        await gateway.mounted('user:alice');

        await gateway.setState({ order: { status: 'failed' } }, { scope: 'user:alice' });
        await gateway.flush();
        await gateway.setState({ order: { status: 'paid' } }, { scope: 'user:alice' });
        await gateway.flush();

        expect(events).toEqual([
            { scope: 'user:alice', mounted: ['email_customer', 'refund_order'], unmounted: [], tools: ['email_customer', 'get_order', 'refund_order'] },
            { scope: 'user:alice', mounted: [], unmounted: ['email_customer', 'refund_order'], tools: ['get_order'] }
        ]);
    });

    it('works for a 2025-era client over a stdio-style connection', async () => {
        const gateway = shop({ notifyDebounceMs: 5, scope: () => undefined });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        gateway.stdio({ transport: serverTransport });
        const notified = vi.fn();
        const client = new Client({ name: 'legacy-client', version: '1.0.0' });
        client.setNotificationHandler('notifications/tools/list_changed', async () => notified());
        await client.connect(clientTransport);
        open.push(client);
        expect(client.getDiscoverResult()).toBeUndefined(); // really the 2025 handshake

        expect(await toolNames(client)).toEqual(['get_order']);
        await gateway.setState({ order: { status: 'failed' } });
        await eventually(() => expect(notified).toHaveBeenCalled());
        expect(await toolNames(client)).toContain('refund_order');
        const result = await client.callTool({ name: 'refund_order', arguments: { id: '7' } });
        expect(JSON.stringify(result.content)).toContain('refunded 7');
    });
});

describe('upstream servers', () => {
    function fakeUpstream(names: string[]): UpstreamClient & { calls: unknown[]; names: string[]; closed: boolean } {
        const upstream = {
            names,
            calls: [] as unknown[],
            closed: false,
            async listTools(params?: { cursor?: string }) {
                // Two pages, to prove the gateway follows cursors.
                const half = Math.ceil(upstream.names.length / 2);
                const page = params?.cursor === 'page2' ? upstream.names.slice(half) : upstream.names.slice(0, half);
                return {
                    tools: page.map(name => ({ name, description: `upstream ${name}`, inputSchema: { type: 'object' as const } })),
                    ...(params?.cursor === 'page2' || upstream.names.length <= half ? {} : { nextCursor: 'page2' })
                };
            },
            async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
                upstream.calls.push(params);
                return text(`upstream ran ${params.name}`);
            },
            async close() {
                upstream.closed = true;
            }
        };
        return upstream;
    }

    it('prefixes upstream tools, gates them, and forwards calls with the original name', async () => {
        const upstream = fakeUpstream(['get_order', 'refund_order', 'email_customer']);
        const gateway = createGateway({
            always: ['shop__get_order'],
            rules: [{ when: { 'order.status': 'failed' }, tools: ['shop__refund_order'] }]
        });
        open.push(gateway);
        await gateway.upstream('shop', upstream);
        const client = await connectModern(gateway.http());
        open.push(client);

        expect(gateway.registeredTools()).toEqual(['shop__email_customer', 'shop__get_order', 'shop__refund_order']);
        expect(await toolNames(client)).toEqual(['shop__get_order']);
        await expect(client.callTool({ name: 'shop__refund_order', arguments: { orderId: '1' } })).rejects.toThrow(/Unknown tool/);
        expect(upstream.calls).toEqual([]);

        await gateway.setState({ order: { status: 'failed' } });
        const result = await client.callTool({ name: 'shop__refund_order', arguments: { orderId: '1' } });
        expect(JSON.stringify(result.content)).toContain('upstream ran refund_order');
        expect(upstream.calls).toEqual([{ name: 'refund_order', arguments: { orderId: '1' } }]);
    });

    it('picks up new and removed upstream tools on refresh', async () => {
        const upstream = fakeUpstream(['a']);
        const gateway = createGateway({ always: ['up__*'] });
        open.push(gateway);
        await gateway.upstream('up', upstream);
        expect(await gateway.mounted()).toEqual(['up__a']);

        upstream.names = ['b', 'c'];
        await gateway.refreshUpstream('up');
        expect(await gateway.mounted()).toEqual(['up__b', 'up__c']);
    });

    it('rejects bad or repeated upstream names and reports a failing upstream', async () => {
        const gateway = createGateway();
        open.push(gateway);
        await expect(gateway.upstream('bad name', fakeUpstream([]))).rejects.toThrow(/invalid upstream name/);
        await gateway.upstream('ok', fakeUpstream(['a']));
        await expect(gateway.upstream('ok', fakeUpstream(['a']))).rejects.toThrow(/already connected/);
        const broken = fakeUpstream([]);
        broken.listTools = async () => {
            throw new Error('down');
        };
        await expect(gateway.upstream('broken', broken)).rejects.toThrow(/could not list tools/);
        expect(broken.closed).toBe(true);
    });

    it('skips an upstream tool whose name would not be a valid MCP name', async () => {
        const onerror = vi.fn();
        const gateway = createGateway({ always: ['*'], onerror });
        open.push(gateway);
        await gateway.upstream('up', fakeUpstream(['fine', 'has space']));
        expect(await gateway.mounted()).toEqual(['up__fine']);
        expect(onerror).toHaveBeenCalledTimes(1);
    });

    it('closes upstream connections when the gateway closes', async () => {
        const upstream = fakeUpstream(['a']);
        const gateway = createGateway();
        await gateway.upstream('up', upstream);
        await gateway.close();
        expect(upstream.closed).toBe(true);
    });
});

describe('guards and custom stores', () => {
    it('rejects bad tool definitions', () => {
        const gateway = createGateway();
        open.push(gateway);
        expect(() => gateway.tool({ name: 'has space' }, async () => text('x'))).toThrow(/invalid tool name/);
        gateway.tool({ name: 'ok' }, async () => text('x'));
        expect(() => gateway.tool({ name: 'ok' }, async () => text('x'))).toThrow(/already registered/);
        expect(() => gateway.tool({ name: 'no_handler' }, undefined as never)).toThrow(/handler/);
    });

    it('rejects a scope function that returns a wrong value', async () => {
        const gateway = createGateway({ scope: () => 42 as never });
        open.push(gateway);
        expect(() => gateway.createServer()).toThrow(/scope\(\)/);
    });

    it('rejects state that is not a plain object', async () => {
        const gateway = createGateway();
        open.push(gateway);
        await expect(gateway.setState([] as never)).rejects.toThrow(TypeError);
        await expect(gateway.replaceState(null as never)).rejects.toThrow(TypeError);
    });

    it('works with an async store that has no patch method', async () => {
        const data = new Map<string, State>();
        const listeners = new Set<(scope: string) => void>();
        const store: StateStore = {
            async get(scope) {
                return data.get(scope) ?? {};
            },
            async set(scope, state) {
                data.set(scope, state);
                for (const listener of listeners) listener(scope);
            },
            subscribe(listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            }
        };
        const gateway = shop({ store });
        expect(await gateway.mounted('t')).toEqual(['get_order']);
        await gateway.setState({ order: { status: 'failed' } }, { scope: 't' });
        await gateway.setState({ order: { note: 'kept' } }, { scope: 't' });
        expect(await gateway.mounted('t')).toContain('refund_order');
        expect(data.get('t')).toEqual({ order: { status: 'failed', note: 'kept' } });
    });

    it('stops reacting after close', async () => {
        const gateway = shop();
        const events: ChangeEvent[] = [];
        gateway.on('change', event => events.push(event));
        await gateway.mounted();
        await gateway.close();
        await gateway.setState({ order: { status: 'failed' } });
        await gateway.flush();
        expect(events).toEqual([]);
    });
});
