import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { validateRule, type Condition } from './rules.js';
import type { State } from './state.js';
import type { UpstreamConfig } from './upstream.js';

/** The JSON config file for the `mcp-effect` command. */
export interface GatewayConfig {
    name?: string;
    version?: string;
    separator?: string;
    denied?: 'hidden' | 'explain';
    instructions?: string;
    /** MCP servers to put behind the gateway, by name. */
    upstreams?: Record<string, UpstreamConfig>;
    /** Tools that are always mounted. */
    always?: string[];
    /** Rules as data: "when this condition is true, mount these tools". */
    rules?: Array<{ name?: string; when?: Condition; tools: string[]; hint?: string }>;
    /** A fixed scope for stdio mode, where there is exactly one caller. */
    scope?: string;
    state?: {
        /** Global state at start. */
        initial?: State;
        /** Per-scope state at start. */
        scopes?: Record<string, State>;
        /**
         * A JSON file to watch: `{ "global": {...}, "scopes": { "user:alice": {...} } }`.
         * Any program in any language can write this file to change state.
         */
        file?: string;
    };
    http?: {
        /** Default 3000. Use 0 for a free port. */
        port?: number;
        /** Default `127.0.0.1`. */
        host?: string;
        /** Default `/mcp`. */
        path?: string;
        /** Host names allowed in the `Host` header when `host` is not loopback. */
        allowedHosts?: string[];
        /**
         * Callers, each with a bearer token read from an environment variable.
         * When set, a request without a known token gets `401`.
         */
        clients?: Array<{ tokenEnv: string; scope?: string }>;
        /** Environment variable that holds the admin token for the `/state` API. */
        adminTokenEnv?: string;
    };
}

class ConfigError extends Error {
    constructor(message: string) {
        super(`mcp-effect config: ${message}`);
        this.name = 'ConfigError';
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(parent: Record<string, unknown>, key: string, where: string): void {
    if (parent[key] !== undefined && typeof parent[key] !== 'string') throw new ConfigError(`${where}.${key} must be a string`);
}

function stringArray(value: unknown, where: string): void {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
        throw new ConfigError(`${where} must be an array of non-empty strings`);
    }
}

function expandEnv(value: string, where: string, env: NodeJS.ProcessEnv): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
        const found = env[name];
        if (found === undefined) throw new ConfigError(`${where} uses \${${name}}, but that environment variable is not set`);
        return found;
    });
}

function expandRecord(record: unknown, where: string, env: NodeJS.ProcessEnv): Record<string, string> {
    if (!isObject(record)) throw new ConfigError(`${where} must be an object of strings`);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
        if (typeof value !== 'string') throw new ConfigError(`${where}.${key} must be a string`);
        out[key] = expandEnv(value, `${where}.${key}`, env);
    }
    return out;
}

/**
 * Checks a parsed config and fills in `${ENV_VAR}` values.
 * Throws an error that names the exact field when something is wrong.
 */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): GatewayConfig {
    if (!isObject(raw)) throw new ConfigError('the file must contain a JSON object');
    const known = new Set(['$schema', 'name', 'version', 'separator', 'denied', 'instructions', 'upstreams', 'always', 'rules', 'scope', 'state', 'http']);
    for (const key of Object.keys(raw)) {
        if (!known.has(key)) throw new ConfigError(`unknown field "${key}"`);
    }
    for (const key of ['name', 'version', 'separator', 'instructions', 'scope']) optionalString(raw, key, 'config');
    if (raw.denied !== undefined && raw.denied !== 'hidden' && raw.denied !== 'explain') {
        throw new ConfigError('denied must be "hidden" or "explain"');
    }
    const config: GatewayConfig = {
        name: raw.name as string | undefined,
        version: raw.version as string | undefined,
        separator: raw.separator as string | undefined,
        denied: raw.denied as GatewayConfig['denied'],
        instructions: raw.instructions as string | undefined,
        scope: raw.scope as string | undefined
    };

    if (raw.upstreams !== undefined) {
        if (!isObject(raw.upstreams)) throw new ConfigError('upstreams must be an object');
        config.upstreams = {};
        for (const [name, value] of Object.entries(raw.upstreams)) {
            const where = `upstreams.${name}`;
            if (!isObject(value)) throw new ConfigError(`${where} must be an object`);
            if (typeof value.url === 'string') {
                config.upstreams[name] = {
                    url: expandEnv(value.url, `${where}.url`, env),
                    ...(value.headers !== undefined ? { headers: expandRecord(value.headers, `${where}.headers`, env) } : {})
                };
            } else if (typeof value.command === 'string' && value.command.length > 0) {
                if (value.args !== undefined) stringArray(value.args, `${where}.args`);
                optionalString(value, 'cwd', where);
                config.upstreams[name] = {
                    command: value.command,
                    args: ((value.args as string[] | undefined) ?? []).map((arg, index) => expandEnv(arg, `${where}.args[${index}]`, env)),
                    ...(value.env !== undefined ? { env: expandRecord(value.env, `${where}.env`, env) } : {}),
                    ...(value.cwd !== undefined ? { cwd: value.cwd as string } : {})
                };
            } else {
                throw new ConfigError(`${where} needs either "command" or "url"`);
            }
        }
    }

    if (raw.always !== undefined) {
        stringArray(raw.always, 'always');
        config.always = raw.always as string[];
    }

    if (raw.rules !== undefined) {
        if (!Array.isArray(raw.rules)) throw new ConfigError('rules must be an array');
        config.rules = raw.rules.map((rule, index) => {
            const where = `rules[${index}]`;
            if (!isObject(rule)) throw new ConfigError(`${where} must be an object`);
            for (const key of Object.keys(rule)) {
                if (!['name', 'when', 'tools', 'hint'].includes(key)) throw new ConfigError(`${where} has an unknown field "${key}"`);
            }
            if (typeof rule.tools === 'function' || !Array.isArray(rule.tools)) throw new ConfigError(`${where}.tools must be an array of tool names`);
            try {
                validateRule(rule as never, where);
            } catch (error) {
                throw new ConfigError((error as Error).message);
            }
            return rule as unknown as NonNullable<GatewayConfig['rules']>[number];
        });
    }

    if (raw.state !== undefined) {
        if (!isObject(raw.state)) throw new ConfigError('state must be an object');
        const state = raw.state;
        if (state.initial !== undefined && !isObject(state.initial)) throw new ConfigError('state.initial must be an object');
        if (state.scopes !== undefined) {
            if (!isObject(state.scopes)) throw new ConfigError('state.scopes must be an object');
            for (const [scope, value] of Object.entries(state.scopes)) {
                if (!isObject(value)) throw new ConfigError(`state.scopes.${scope} must be an object`);
            }
        }
        optionalString(state, 'file', 'state');
        config.state = state as GatewayConfig['state'];
    }

    if (raw.http !== undefined) {
        if (!isObject(raw.http)) throw new ConfigError('http must be an object');
        const http = raw.http;
        if (http.port !== undefined && (typeof http.port !== 'number' || !Number.isInteger(http.port) || http.port < 0 || http.port > 65_535)) {
            throw new ConfigError('http.port must be a whole number from 0 to 65535');
        }
        for (const key of ['host', 'path', 'adminTokenEnv']) optionalString(http, key, 'http');
        if (typeof http.path === 'string' && !http.path.startsWith('/')) throw new ConfigError('http.path must start with "/"');
        if (http.allowedHosts !== undefined) stringArray(http.allowedHosts, 'http.allowedHosts');
        if (http.clients !== undefined) {
            if (!Array.isArray(http.clients)) throw new ConfigError('http.clients must be an array');
            http.clients.forEach((client, index) => {
                if (!isObject(client) || typeof client.tokenEnv !== 'string' || client.tokenEnv.length === 0) {
                    throw new ConfigError(`http.clients[${index}].tokenEnv must name an environment variable`);
                }
                if (client.scope !== undefined && (typeof client.scope !== 'string' || client.scope.length === 0)) {
                    throw new ConfigError(`http.clients[${index}].scope must be a non-empty string`);
                }
            });
        }
        config.http = http as GatewayConfig['http'];
    }
    return config;
}

/** Reads and checks a config file. */
export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<GatewayConfig> {
    const absolute = resolve(path);
    let text: string;
    try {
        text = await readFile(absolute, 'utf8');
    } catch (error) {
        throw new ConfigError(`could not read ${absolute}: ${(error as Error).message}`);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new ConfigError(`${absolute} is not valid JSON: ${(error as Error).message}`);
    }
    return parseConfig(raw, env);
}
