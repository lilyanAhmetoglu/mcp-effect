import { Client, StreamableHTTPClientTransport, type ClientOptions } from '@modelcontextprotocol/client';
import type { AuthInfo, McpHttpHandler } from '@modelcontextprotocol/server';

/** Connects a 2026-07-28 client straight to a handler, with no network. */
export async function connectModern(handler: McpHttpHandler, authInfo?: AuthInfo, options: ClientOptions = {}): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
        fetch: (url, init) => handler.fetch(new Request(url, init), authInfo ? { authInfo } : undefined)
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' }, ...options });
    await client.connect(transport);
    // Make sure these tests really speak the 2026-07-28 revision.
    if (!client.getDiscoverResult()) throw new Error('expected a 2026-07-28 connection');
    return client;
}

export function auth(scope: string): AuthInfo {
    return { token: `token-${scope}`, clientId: scope, scopes: [] };
}

export async function toolNames(client: Client): Promise<string[]> {
    return (await client.listTools()).tools.map(tool => tool.name);
}

/** Waits until `check` stops throwing, or fails after `timeoutMs`. */
export async function eventually<T>(check: () => T | Promise<T>, timeoutMs = 3000): Promise<T> {
    const start = Date.now();
    for (;;) {
        try {
            return await check();
        } catch (error) {
            if (Date.now() - start > timeoutMs) throw error;
            await new Promise(resolve => setTimeout(resolve, 15));
        }
    }
}

export const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
