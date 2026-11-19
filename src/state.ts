/** A plain JSON-like object that holds gateway state. */
export type State = Record<string, unknown>;

/** The scope that every caller shares. */
export const GLOBAL_SCOPE = 'global';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Reads a value by dot path, for example `getPath(state, 'order.status')`.
 * Returns `undefined` when any part of the path is missing.
 */
export function getPath(state: unknown, path: string): unknown {
    let current: unknown = state;
    for (const key of path.split('.')) {
        if (FORBIDDEN_KEYS.has(key)) return undefined;
        if (current === null || typeof current !== 'object') return undefined;
        if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

/** Structural equality for JSON-like values. */
export function deepEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
        return true;
    }
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
    }
    return true;
}

/**
 * Returns a new object: `base` with `patch` merged in.
 *
 * - Plain objects merge key by key.
 * - Arrays and other values are replaced.
 * - A `null` in the patch deletes that key.
 * - Keys that could pollute a prototype are dropped.
 */
export function deepMerge(base: State, patch: State): State {
    const out: State = {};
    for (const [key, value] of Object.entries(base)) {
        if (!FORBIDDEN_KEYS.has(key)) out[key] = value;
    }
    for (const [key, value] of Object.entries(patch)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        if (value === null) {
            delete out[key];
        } else if (isPlainObject(value)) {
            const previous = out[key];
            out[key] = deepMerge(isPlainObject(previous) ? previous : {}, value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

/** Checks that a value is a plain object that can be used as state. */
export function assertState(value: unknown, what = 'state'): asserts value is State {
    if (!isPlainObject(value)) throw new TypeError(`${what} must be a plain object`);
}

/**
 * Where the gateway keeps state. One state object per scope.
 *
 * The default is {@link MemoryStateStore}. To run several gateway processes,
 * implement this interface over a shared store (Redis, Postgres, ...) and call
 * the listeners when another process writes.
 */
export interface StateStore {
    /** Returns the state of one scope. Returns `{}` for an unknown scope. */
    get(scope: string): State | Promise<State>;
    /** Replaces the state of one scope. */
    set(scope: string, state: State): void | Promise<void>;
    /** Optional atomic merge. When missing, the gateway does get + merge + set. */
    patch?(scope: string, patch: State): void | Promise<void>;
    /** Calls `listener(scope)` after each write. Returns an unsubscribe function. */
    subscribe(listener: (scope: string) => void): () => void;
}

/** In-process state store. Good for one gateway process. */
export class MemoryStateStore implements StateStore {
    private readonly scopes = new Map<string, State>();
    private readonly listeners = new Set<(scope: string) => void>();

    constructor(initial: State = {}) {
        assertState(initial, 'initial state');
        this.scopes.set(GLOBAL_SCOPE, structuredClone(initial));
    }

    get(scope: string): State {
        return this.scopes.get(scope) ?? {};
    }

    set(scope: string, state: State): void {
        assertState(state);
        const next = deepMerge({}, structuredClone(state));
        if (deepEqual(this.scopes.get(scope) ?? {}, next)) return;
        this.scopes.set(scope, next);
        this.emit(scope);
    }

    patch(scope: string, patch: State): void {
        assertState(patch, 'patch');
        const previous = this.scopes.get(scope) ?? {};
        const next = deepMerge(previous, structuredClone(patch));
        if (deepEqual(previous, next)) return;
        this.scopes.set(scope, next);
        this.emit(scope);
    }

    /** Removes a scope, for example when a user logs out. */
    delete(scope: string): void {
        if (scope === GLOBAL_SCOPE) {
            this.set(GLOBAL_SCOPE, {});
            return;
        }
        if (this.scopes.delete(scope)) this.emit(scope);
    }

    /** Names of all scopes that hold state. */
    scopeNames(): string[] {
        return [...this.scopes.keys()];
    }

    subscribe(listener: (scope: string) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private emit(scope: string): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(scope);
            } catch {
                // A broken listener must not stop a state write.
            }
        }
    }
}
