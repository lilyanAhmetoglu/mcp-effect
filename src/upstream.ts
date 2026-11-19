import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { CallToolResult, Tool } from '@modelcontextprotocol/server';

/** Start a local MCP server as a child process and talk to it over stdio. */
export interface StdioUpstreamConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
}

/** Talk to a remote MCP server over Streamable HTTP. */
export interface HttpUpstreamConfig {
    url: string;
    /** Extra headers for every request, for example `Authorization`. */
    headers?: Record<string, string>;
}

export type UpstreamConfig = StdioUpstreamConfig | HttpUpstreamConfig;

/**
 * The small part of an MCP client the gateway needs.
 * The SDK's `Client` fits this shape, and so does a hand-written fake in tests.
 */
export interface UpstreamClient {
    listTools(params?: { cursor?: string }): Promise<{ tools: Tool[]; nextCursor?: string }>;
    callTool(params: { name: string; arguments?: Record<string, unknown> }, options?: { signal?: AbortSignal }): Promise<CallToolResult>;
    close?(): Promise<void>;
}

/** Connects to an upstream MCP server and watches its tool list. */
export async function connectUpstream(
    name: string,
    config: UpstreamConfig,
    onToolsChanged: (tools: Tool[]) => void,
    onerror: (error: Error) => void
): Promise<UpstreamClient> {
    const client = new Client(
        { name: `mcp-effect/${name}`, version: '0.1.0' },
        {
            // Speak the newest revision the upstream serves, and fall back for older servers.
            versionNegotiation: { mode: 'auto' },
            listChanged: {
                tools: {
                    onChanged: (error, tools) => {
                        if (error) onerror(new Error(`mcp-effect: upstream "${name}" could not refresh its tools`, { cause: error }));
                        else if (tools) onToolsChanged(tools);
                    }
                }
            }
        }
    );
    client.onerror = error => onerror(new Error(`mcp-effect: upstream "${name}" reported an error`, { cause: error }));

    if ('url' in config) {
        let url: URL;
        try {
            url = new URL(config.url);
        } catch {
            throw new TypeError(`upstream "${name}": "${config.url}" is not a valid URL`);
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError(`upstream "${name}": the URL must use http or https`);
        await client.connect(new StreamableHTTPClientTransport(url, config.headers ? { requestInit: { headers: config.headers } } : undefined));
    } else if (typeof config.command === 'string' && config.command.length > 0) {
        await client.connect(
            new StdioClientTransport({
                command: config.command,
                args: config.args ?? [],
                ...(config.env ? { env: { ...defaultEnv(), ...config.env } } : {}),
                ...(config.cwd ? { cwd: config.cwd } : {}),
                stderr: 'inherit'
            })
        );
    } else {
        throw new TypeError(`upstream "${name}" needs either "command" or "url"`);
    }
    return client as unknown as UpstreamClient;
}

/** The child gets a small, safe set of variables plus whatever the config adds. */
function defaultEnv(): Record<string, string> {
    const keep = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'APPDATA', 'USERPROFILE', 'PATHEXT', 'ComSpec'];
    const out: Record<string, string> = {};
    for (const key of keep) {
        const value = process.env[key];
        if (value !== undefined) out[key] = value;
    }
    return out;
}
