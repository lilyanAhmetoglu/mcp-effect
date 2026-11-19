import {
    createMcpHandler,
    ProtocolError,
    ProtocolErrorCode,
    Server,
    type AuthInfo,
    type CallToolResult,
    type CreateMcpHandlerOptions,
    type McpHttpHandler,
    type McpRequestContext,
    type Tool
} from '@modelcontextprotocol/server';
import { serveStdio, type ServeStdioOptions, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import { matchTools, RuleEngine, type UseToolsRule } from './rules.js';
import { assertState, deepMerge, GLOBAL_SCOPE, MemoryStateStore, type State, type StateStore } from './state.js';
import { connectUpstream, type UpstreamClient, type UpstreamConfig } from './upstream.js';

/** What a local tool handler gets besides its arguments. */
export interface ToolCallContext {
    /** The caller's scope, or `undefined` for the shared global scope. */
    scope: string | undefined;
    /** The state this call was allowed under. */
    state: State;
    /** Aborts when the client cancels the call. */
    signal?: AbortSignal;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolCallContext) => CallToolResult | Promise<CallToolResult>;

/** Facts about one request that decide which scope it belongs to. */
export interface ScopeInput {
    /** Verified auth for this request. Only set on HTTP, and only when you pass it to `fetch`. */
    authInfo?: AuthInfo;
    /** The raw HTTP request, when there is one. */
    request?: Request;
}

/** Sent to `gateway.on('change', ...)` when a scope's mounted tools change. */
export interface ChangeEvent {
    /** The scope that changed. `'global'` is the shared scope. */
    scope: string;
    /** Tools that just appeared. */
    mounted: string[];
    /** Tools that just disappeared. */
    unmounted: string[];
    /** All tools mounted now. */
    tools: string[];
}

export interface GatewayOptions {
    /** Server name shown to MCP clients. */
    name?: string;
    /** Server version shown to MCP clients. */
    version?: string;
    /** Tools that are always mounted. `*` is a wildcard. Default: none. */
    always?: string[];
    /** Rules to start with. Same as calling `useTools` for each. */
    rules?: UseToolsRule[];
    /** Where state lives. Default: a new {@link MemoryStateStore}. */
    store?: StateStore;
    /** First global state, when no `store` is given. */
    initialState?: State;
    /**
     * Picks the scope for a request. Return a stable id for the caller, such as
     * `user:alice` or `tenant:acme`, or `undefined` to use only global state.
     *
     * Build it from verified auth only. The MCP spec allows the tool list to
     * differ by the caller's authorization, but not by connection.
     */
    scope?: (input: ScopeInput) => string | undefined;
    /**
     * What a call to an unmounted tool gets back.
     * - `'hidden'` (default): the same "Unknown tool" error as a tool that does not exist.
     * - `'explain'`: a tool error the model can read, with the rule's hint.
     */
    denied?: 'hidden' | 'explain';
    /** Text between an upstream name and its tool name. Default `__`. */
    separator?: string;
    /** Wait this long to group state changes into one notification. Default 25 ms. */
    notifyDebounceMs?: number;
    /** How many scopes to remember for change detection. Default 10 000. */
    maxScopes?: number;
    /** Extra text for the server's `instructions`. Rule hints are added after it. */
    instructions?: string;
    /** Gets errors that have nowhere else to go (a rule that threw, a failed notification). */
    onerror?: (error: Error) => void;
}

interface ToolEntry {
    definition: Tool;
    source: string;
    call: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<CallToolResult>;
}

interface Resolution {
    key: string;
    names: string[];
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const UPSTREAM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * An MCP gateway that mounts tools only when state allows.
 *
 * Think of `useEffect`: you declare dependencies, and the gateway re-runs your
 * rule when they change. Here the "effect" is which tools exist.
 */
export class Gateway {
    readonly store: StateStore;

    private readonly options: Required<Pick<GatewayOptions, 'name' | 'version' | 'denied' | 'separator' | 'notifyDebounceMs' | 'maxScopes'>> &
        GatewayOptions;
    private readonly engine: RuleEngine;
    private readonly always: string[];
    private readonly tools = new Map<string, ToolEntry>();
    private readonly toolNames = new Set<string>();
    private registryVersion = 0;
    /** Wildcard matches for the current registry. Cleared when tools change. */
    private readonly wildcardCache = new Map<string, readonly string[]>();
    private readonly upstreams = new Map<string, UpstreamClient>();

    /** Last answer per scope. Also the list of scopes we watch for changes. */
    private readonly resolved = new Map<string, Resolution>();
    private readonly listeners = new Set<(event: ChangeEvent) => void>();
    private readonly connectedServers = new Set<Server>();
    private readonly httpHandlers = new Set<McpHttpHandler>();
    private readonly stdioHandles = new Set<StdioServerHandle>();
    private readonly unsubscribeStore: () => void;

    private readonly dirtyScopes = new Set<string>();
    private dirtyAll = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private flushing: Promise<void> | undefined;
    private closed = false;

    constructor(options: GatewayOptions = {}) {
        this.options = {
            ...options,
            name: options.name ?? 'mcp-effect',
            version: options.version ?? '0.1.0',
            denied: options.denied ?? 'hidden',
            separator: options.separator ?? '__',
            notifyDebounceMs: options.notifyDebounceMs ?? 25,
            maxScopes: options.maxScopes ?? 10_000
        };
        if (!/^[A-Za-z0-9_.-]+$/.test(this.options.separator)) throw new TypeError('separator may only use letters, digits, "_", "-" and "."');
        this.always = [...(options.always ?? [])];
        this.engine = new RuleEngine(this.options.maxScopes, error => this.report(error));
        for (const rule of options.rules ?? []) this.engine.add(rule);
        this.store = options.store ?? new MemoryStateStore(options.initialState ?? {});
        this.unsubscribeStore = this.store.subscribe(scope => this.markDirty(scope));
    }

    // ----- rules -------------------------------------------------------------

    /**
     * Adds a rule: "when these deps look like this, mount these tools".
     *
     * ```ts
     * gateway.useTools({
     *     deps: ['order.status'],
     *     tools: state => (getPath(state, 'order.status') === 'failed' ? ['shop__refund'] : [])
     * });
     * ```
     */
    useTools(rule: UseToolsRule): this {
        this.engine.add(rule);
        this.engine.reset();
        this.markDirty(GLOBAL_SCOPE);
        return this;
    }

    // ----- tools -------------------------------------------------------------

    /** Registers a tool that runs inside the gateway process. */
    tool(definition: Pick<Tool, 'name'> & Partial<Tool>, handler: ToolHandler): this {
        const name = definition.name;
        if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
            throw new TypeError(`invalid tool name "${String(name)}": use 1-128 letters, digits, "_", "-" or "."`);
        }
        if (this.tools.has(name)) throw new Error(`tool "${name}" is already registered`);
        if (typeof handler !== 'function') throw new TypeError(`tool "${name}" needs a handler function`);
        const full: Tool = { inputSchema: { type: 'object' }, ...definition, name } as Tool;
        this.tools.set(name, { definition: full, source: 'local', call: async (args, ctx) => handler(args, ctx) });
        this.registryChanged();
        return this;
    }

    /**
     * Connects another MCP server and puts its tools behind this gateway.
     * Its tools are named `<name><separator><tool>`, for example `shop__refund`.
     *
     * Pass a config to let the gateway connect, or pass your own connected client.
     */
    async upstream(name: string, target: UpstreamConfig | UpstreamClient): Promise<this> {
        if (!UPSTREAM_PATTERN.test(name)) throw new TypeError(`invalid upstream name "${name}": use letters, digits, "_" or "-"`);
        if (this.upstreams.has(name)) throw new Error(`upstream "${name}" is already connected`);
        const isClient = typeof (target as UpstreamClient).listTools === 'function' && typeof (target as UpstreamClient).callTool === 'function';
        const client = isClient
            ? (target as UpstreamClient)
            : await connectUpstream(name, target as UpstreamConfig, tools => this.setUpstreamTools(name, tools), error => this.report(error));
        this.upstreams.set(name, client);
        try {
            await this.refreshUpstream(name);
        } catch (error) {
            this.upstreams.delete(name);
            await client.close?.().catch(() => {});
            throw new Error(`mcp-effect: could not list tools of upstream "${name}"`, { cause: error });
        }
        return this;
    }

    /** Lists the upstream's tools again. Call it when you know they changed. */
    async refreshUpstream(name: string): Promise<void> {
        const client = this.upstreams.get(name);
        if (!client) throw new Error(`unknown upstream "${name}"`);
        const tools: Tool[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
            const page = await client.listTools(cursor ? { cursor } : undefined);
            tools.push(...page.tools);
            cursor = page.nextCursor;
            if (cursor !== undefined) {
                if (seen.has(cursor)) break; // A broken upstream must not loop us forever.
                seen.add(cursor);
            }
        } while (cursor !== undefined);
        this.setUpstreamTools(name, tools);
    }

    private setUpstreamTools(name: string, tools: Tool[]): void {
        const client = this.upstreams.get(name);
        if (!client) return;
        for (const [toolName, entry] of this.tools) {
            if (entry.source === name) this.tools.delete(toolName);
        }
        for (const tool of tools) {
            const exposed = `${name}${this.options.separator}${tool.name}`;
            if (!NAME_PATTERN.test(exposed)) {
                this.report(new Error(`mcp-effect: skipped upstream tool "${exposed}": the name is not a valid MCP tool name`));
                continue;
            }
            if (this.tools.has(exposed)) {
                this.report(new Error(`mcp-effect: skipped upstream tool "${exposed}": the name is already taken`));
                continue;
            }
            const upstreamName = tool.name;
            this.tools.set(exposed, {
                definition: { ...tool, name: exposed },
                source: name,
                call: async (args, ctx) =>
                    withoutProtocolMeta(await client.callTool({ name: upstreamName, arguments: args }, ctx.signal ? { signal: ctx.signal } : undefined))
            });
        }
        this.registryChanged();
    }

    private registryChanged(): void {
        this.toolNames.clear();
        for (const name of this.tools.keys()) this.toolNames.add(name);
        this.registryVersion++;
        this.wildcardCache.clear();
        this.markDirty(GLOBAL_SCOPE);
    }

    /** Names of every registered tool, mounted or not. */
    registeredTools(): string[] {
        return [...this.toolNames].sort();
    }

    // ----- state -------------------------------------------------------------

    /**
     * Merges a patch into state. A `null` value deletes a key.
     * Without `scope`, it changes the global state that every caller shares.
     */
    async setState(patch: State, options: { scope?: string } = {}): Promise<void> {
        assertState(patch, 'patch');
        const scope = options.scope ?? GLOBAL_SCOPE;
        if (this.store.patch) {
            await this.store.patch(scope, patch);
        } else {
            await this.store.set(scope, deepMerge(await this.store.get(scope), patch));
        }
    }

    /** Replaces the whole state of a scope. */
    async replaceState(state: State, options: { scope?: string } = {}): Promise<void> {
        assertState(state);
        await this.store.set(options.scope ?? GLOBAL_SCOPE, state);
    }

    /** The state a caller in this scope sees: global state with the scope's state on top. */
    async getState(scope?: string): Promise<State> {
        const globalState = await this.store.get(GLOBAL_SCOPE);
        if (scope === undefined || scope === GLOBAL_SCOPE) return globalState;
        return deepMerge(globalState, await this.store.get(scope));
    }

    // ----- resolution --------------------------------------------------------

    /** Names of the tools mounted for a scope right now, sorted. */
    async mounted(scope?: string): Promise<string[]> {
        return (await this.resolve(scope)).names;
    }

    private async resolve(scope: string | undefined): Promise<{ names: string[]; state: State }> {
        const key = scope ?? GLOBAL_SCOPE;
        const state = await this.getState(scope);
        const patterns = [...this.always, ...this.engine.resolve(key, state, { scope: key === GLOBAL_SCOPE ? undefined : key })];
        const cacheKey = `${this.registryVersion}\u0000${patterns.join('\u0000')}`;
        const previous = this.resolved.get(key);
        let names: string[];
        if (previous && previous.key === cacheKey) {
            names = previous.names;
            this.resolved.delete(key);
            this.resolved.set(key, previous);
        } else {
            names = matchTools(patterns, this.toolNames, this.wildcardCache);
            if (previous) {
                this.resolved.delete(key);
                this.emitChange(key, previous.names, names);
            }
            this.resolved.set(key, { key: cacheKey, names });
            if (this.resolved.size > this.options.maxScopes) {
                const oldest = this.resolved.keys().next().value;
                if (oldest !== undefined) this.resolved.delete(oldest);
            }
        }
        return { names, state };
    }

    private emitChange(scope: string, before: string[], after: string[]): boolean {
        const beforeSet = new Set(before);
        const afterSet = new Set(after);
        const mounted = after.filter(name => !beforeSet.has(name));
        const unmounted = before.filter(name => !afterSet.has(name));
        if (mounted.length === 0 && unmounted.length === 0) return false;
        this.needsNotify = true;
        const event: ChangeEvent = { scope, mounted, unmounted, tools: [...after] };
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            } catch (error) {
                this.report(error instanceof Error ? error : new Error(String(error)));
            }
        }
        return true;
    }

    private needsNotify = false;

    // ----- serving -----------------------------------------------------------

    /** The tool definitions a scope may see, in a stable order. */
    async listTools(scope?: string): Promise<Tool[]> {
        const { names } = await this.resolve(scope);
        const out: Tool[] = [];
        for (const name of names) {
            const entry = this.tools.get(name);
            if (entry) out.push(entry.definition);
        }
        return out;
    }

    /**
     * Calls a tool for a scope. The mount check runs here again, with fresh
     * state, so a client with an old tool list cannot call an unmounted tool.
     */
    async callTool(scope: string | undefined, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<CallToolResult> {
        const entry = this.tools.get(name);
        const { names, state } = await this.resolve(scope);
        // `names` is sorted, but a Set lookup is simpler and the list is small per scope.
        if (!entry || !names.includes(name)) {
            if (entry && this.options.denied === 'explain') {
                const hints = this.engine.rules.map(rule => rule.hint).filter((hint): hint is string => Boolean(hint));
                const text = [`Tool "${name}" is not available right now.`, ...hints].join(' ');
                return { content: [{ type: 'text', text }], isError: true };
            }
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
        }
        return entry.call(args, { scope, state, signal });
    }

    /**
     * Builds one MCP server instance. Use it as the factory for the SDK's
     * `createMcpHandler` or `serveStdio` when you wire serving yourself.
     */
    createServer = (ctx?: McpRequestContext): Server => {
        const scope = this.options.scope?.({ authInfo: ctx?.authInfo, request: ctx?.requestInfo });
        if (scope !== undefined && (typeof scope !== 'string' || scope.length === 0)) {
            throw new TypeError('scope() must return a non-empty string or undefined');
        }
        const server = new Server(
            { name: this.options.name, version: this.options.version },
            { capabilities: { tools: { listChanged: true } }, instructions: this.instructions() }
        );
        server.setRequestHandler('tools/list', async () => ({ tools: await this.listTools(scope) }));
        server.setRequestHandler('tools/call', async (request, requestCtx) =>
            this.callTool(scope, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>, requestCtx?.mcpReq?.signal)
        );
        return server;
    };

    /**
     * Serves over stdio. One client, one process. This is what desktop clients
     * such as Claude Code start with `command` and `args`.
     */
    stdio(options: ServeStdioOptions = {}): StdioServerHandle {
        const handle = serveStdio(
            ctx => {
                const server = this.createServer(ctx);
                // stdio keeps one instance per connection, so we can notify it directly.
                this.connectedServers.add(server);
                const previous = server.onclose;
                server.onclose = () => {
                    this.connectedServers.delete(server);
                    previous?.();
                };
                return server;
            },
            { onerror: error => this.report(error), ...options }
        );
        this.stdioHandles.add(handle);
        return handle;
    }

    /**
     * Returns a web-standard handler: `handler.fetch(request, { authInfo })`.
     * It is stateless per request, so you can run many copies behind a load balancer.
     * Verify the caller's token yourself and pass the result as `authInfo`.
     */
    http(options: CreateMcpHandlerOptions = {}): McpHttpHandler {
        const handler = createMcpHandler(ctx => this.createServer(ctx), { onerror: error => this.report(error), ...options });
        this.httpHandlers.add(handler);
        return handler;
    }

    private instructions(): string | undefined {
        const hints = this.engine.rules.map(rule => rule.hint).filter((hint): hint is string => Boolean(hint));
        const parts: string[] = [];
        if (this.options.instructions) parts.push(this.options.instructions);
        if (hints.length > 0) {
            parts.push(['Some tools are mounted only when state allows:', ...hints.map(hint => `- ${hint}`)].join('\n'));
        }
        return parts.length > 0 ? parts.join('\n\n') : undefined;
    }

    // ----- change detection --------------------------------------------------

    /** Listens for mounted-tool changes. Returns an unsubscribe function. */
    on(event: 'change', listener: (event: ChangeEvent) => void): () => void {
        if (event !== 'change') throw new TypeError(`unknown event "${String(event)}"`);
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private markDirty(scope: string): void {
        if (this.closed) return;
        if (scope === GLOBAL_SCOPE) this.dirtyAll = true;
        else this.dirtyScopes.add(scope);
        if (this.timer === undefined) {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                void this.flush();
            }, this.options.notifyDebounceMs);
            // Do not keep the process alive just for a pending notification.
            (this.timer as { unref?: () => void }).unref?.();
        }
    }

    /**
     * Applies pending state changes now: re-checks the watched scopes and
     * notifies clients if any tool list changed. Mostly useful in tests.
     */
    async flush(): Promise<void> {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        while (this.flushing) await this.flushing;
        if (!this.dirtyAll && this.dirtyScopes.size === 0) return;
        this.flushing = this.runFlush().finally(() => {
            this.flushing = undefined;
        });
        await this.flushing;
        // A write that landed while we were flushing gets its own pass.
        if (this.dirtyAll || this.dirtyScopes.size > 0) await this.flush();
    }

    private async runFlush(): Promise<void> {
        const scopes = this.dirtyAll ? [...this.resolved.keys()] : [...this.dirtyScopes].filter(scope => this.resolved.has(scope));
        // A scope nobody has asked about yet has no known list, so a client that
        // holds one could not exist. Unknown dirty scopes need no notification.
        this.dirtyAll = false;
        this.dirtyScopes.clear();
        for (const scope of scopes) {
            try {
                await this.resolve(scope === GLOBAL_SCOPE ? undefined : scope);
            } catch (error) {
                this.report(error instanceof Error ? error : new Error(String(error)));
                this.needsNotify = true; // Unsure, so tell clients to look again.
            }
        }
        if (this.needsNotify) {
            this.needsNotify = false;
            this.notifyClients();
        }
    }

    private notifyClients(): void {
        for (const handler of this.httpHandlers) {
            try {
                handler.notify.toolsChanged();
            } catch (error) {
                this.report(error instanceof Error ? error : new Error(String(error)));
            }
        }
        for (const server of this.connectedServers) {
            server.sendToolListChanged().catch(() => {
                // Not connected yet, or already gone. Nothing to tell.
            });
        }
    }

    // ----- lifecycle ---------------------------------------------------------

    /** Stops serving and closes upstream connections. */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        this.unsubscribeStore();
        await Promise.allSettled([
            ...[...this.httpHandlers].map(handler => handler.close()),
            ...[...this.stdioHandles].map(handle => handle.close()),
            ...[...this.upstreams.values()].map(client => client.close?.())
        ]);
        this.httpHandlers.clear();
        this.stdioHandles.clear();
        this.connectedServers.clear();
        this.upstreams.clear();
        this.listeners.clear();
    }

    private report(error: Error): void {
        try {
            this.options.onerror?.(error);
        } catch {
            // The error reporter itself failed. There is nowhere left to report to.
        }
    }
}

/**
 * An upstream stamps its own protocol metadata (such as its server name) on a
 * result. The client is talking to the gateway, so that metadata must not pass
 * through. Other `_meta` keys are kept.
 */
function withoutProtocolMeta(result: CallToolResult): CallToolResult {
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    if (!meta || typeof meta !== 'object') return result;
    const kept = Object.fromEntries(Object.entries(meta).filter(([key]) => !key.startsWith('io.modelcontextprotocol/')));
    const { _meta: _dropped, ...rest } = result as CallToolResult & { _meta?: unknown };
    return (Object.keys(kept).length > 0 ? { ...rest, _meta: kept } : rest) as CallToolResult;
}

/** Creates a {@link Gateway}. */
export function createGateway(options: GatewayOptions = {}): Gateway {
    return new Gateway(options);
}
