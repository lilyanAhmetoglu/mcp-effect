import { deepEqual, getPath, type State } from './state.js';

/** Extra facts a rule can read. */
export interface RuleContext {
    /** The caller's scope, or `undefined` for the shared global scope. */
    scope: string | undefined;
}

/** A comparison against one state path. A bare value means "equals". */
export type Operator =
    | { eq: unknown }
    | { ne: unknown }
    | { in: unknown[] }
    | { nin: unknown[] }
    | { gt: number }
    | { gte: number }
    | { lt: number }
    | { lte: number }
    | { exists: boolean }
    | { contains: unknown };

/**
 * A condition written as data, so it can live in a JSON file.
 *
 * ```json
 * { "order.status": "failed", "order.total": { "gt": 100 } }
 * { "any": [{ "plan": "pro" }, { "plan": "team" }] }
 * { "not": { "account.frozen": true } }
 * ```
 *
 * Several paths in one object must all match.
 */
export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | { [path: string]: unknown };

/** One `useTools` rule: "when these deps look like this, mount these tools". */
export interface UseToolsRule {
    /** A name for logs and errors. */
    name?: string;
    /**
     * State paths this rule reads, like a `useEffect` dependency array.
     * The `tools` function runs again only when one of these values changes.
     * Leave it out to run the function on every check.
     */
    deps?: string[];
    /** A condition as data. The rule mounts its tools only while this is true. */
    when?: Condition;
    /**
     * Tool names to mount. `*` is a wildcard, so `stripe__*` mounts every Stripe tool.
     * A function gets the current state and returns the names.
     */
    tools: string[] | ((state: State, ctx: RuleContext) => string[] | null | undefined | false);
    /** One short line that tells the model when these tools appear. */
    hint?: string;
}

const OPERATOR_KEYS = new Set(['eq', 'ne', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains']);

function isOperator(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every(key => OPERATOR_KEYS.has(key));
}

function compare(actual: unknown, expected: unknown): boolean {
    if (!isOperator(expected)) return deepEqual(actual, expected);
    for (const [op, operand] of Object.entries(expected)) {
        let ok: boolean;
        switch (op) {
            case 'eq':
                ok = deepEqual(actual, operand);
                break;
            case 'ne':
                ok = !deepEqual(actual, operand);
                break;
            case 'in':
                ok = Array.isArray(operand) && operand.some(item => deepEqual(actual, item));
                break;
            case 'nin':
                ok = Array.isArray(operand) && !operand.some(item => deepEqual(actual, item));
                break;
            case 'gt':
                ok = typeof actual === 'number' && typeof operand === 'number' && actual > operand;
                break;
            case 'gte':
                ok = typeof actual === 'number' && typeof operand === 'number' && actual >= operand;
                break;
            case 'lt':
                ok = typeof actual === 'number' && typeof operand === 'number' && actual < operand;
                break;
            case 'lte':
                ok = typeof actual === 'number' && typeof operand === 'number' && actual <= operand;
                break;
            case 'exists':
                ok = (actual !== undefined) === Boolean(operand);
                break;
            case 'contains':
                ok =
                    (Array.isArray(actual) && actual.some(item => deepEqual(item, operand))) ||
                    (typeof actual === 'string' && typeof operand === 'string' && actual.includes(operand));
                break;
            default:
                ok = false;
        }
        if (!ok) return false;
    }
    return true;
}

/** Checks a {@link Condition} against state. */
export function evaluate(condition: Condition, state: State): boolean {
    const record = condition as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
        if (key === 'all' && Array.isArray(value)) {
            if (!value.every(item => evaluate(item as Condition, state))) return false;
        } else if (key === 'any' && Array.isArray(value)) {
            if (!value.some(item => evaluate(item as Condition, state))) return false;
        } else if (key === 'not' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
            if (evaluate(value as Condition, state)) return false;
        } else if (!compare(getPath(state, key), value)) {
            return false;
        }
    }
    return true;
}

/** Lists every state path a {@link Condition} reads. */
export function conditionPaths(condition: Condition, into = new Set<string>()): Set<string> {
    for (const [key, value] of Object.entries(condition as Record<string, unknown>)) {
        if ((key === 'all' || key === 'any') && Array.isArray(value)) {
            for (const item of value) conditionPaths(item as Condition, into);
        } else if (key === 'not' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
            conditionPaths(value as Condition, into);
        } else {
            into.add(key);
        }
    }
    return into;
}

/** Throws a clear error when a rule is not well formed. */
export function validateRule(rule: UseToolsRule, label = 'rule'): void {
    if (rule === null || typeof rule !== 'object') throw new TypeError(`${label} must be an object`);
    const tools = rule.tools;
    if (typeof tools !== 'function') {
        if (!Array.isArray(tools) || tools.some(name => typeof name !== 'string' || name.length === 0)) {
            throw new TypeError(`${label}.tools must be a function or an array of tool names`);
        }
    }
    if (rule.deps !== undefined && (!Array.isArray(rule.deps) || rule.deps.some(dep => typeof dep !== 'string' || dep.length === 0))) {
        throw new TypeError(`${label}.deps must be an array of state paths`);
    }
    if (rule.when !== undefined && (rule.when === null || typeof rule.when !== 'object' || Array.isArray(rule.when))) {
        throw new TypeError(`${label}.when must be a condition object`);
    }
    if (rule.hint !== undefined && typeof rule.hint !== 'string') throw new TypeError(`${label}.hint must be a string`);
}

interface CompiledRule {
    rule: UseToolsRule;
    /** `undefined` means "no dependency array": run on every check. */
    deps: string[] | undefined;
}

function compileRule(rule: UseToolsRule): CompiledRule {
    let deps = rule.deps;
    if (deps === undefined && typeof rule.tools !== 'function') {
        // A rule made only of data depends on exactly the paths its condition reads.
        deps = rule.when ? [...conditionPaths(rule.when)] : [];
    } else if (deps !== undefined && rule.when) {
        deps = [...new Set([...deps, ...conditionPaths(rule.when)])];
    }
    return { rule, deps };
}

interface MemoEntry {
    depValues: unknown[];
    patterns: readonly string[];
}

/**
 * Runs rules against state and remembers the answers per scope.
 *
 * This is the "dependency array" part: a rule with `deps` runs its function
 * again only when one of those state values changes.
 */
export class RuleEngine {
    private readonly compiled: CompiledRule[] = [];
    private readonly memo = new Map<string, Array<MemoEntry | undefined>>();

    constructor(
        private readonly maxScopes = 10_000,
        private readonly onerror: (error: Error) => void = () => {}
    ) {}

    add(rule: UseToolsRule): void {
        validateRule(rule, rule.name ? `rule "${rule.name}"` : `rule #${this.compiled.length + 1}`);
        this.compiled.push(compileRule(rule));
    }

    get rules(): readonly UseToolsRule[] {
        return this.compiled.map(entry => entry.rule);
    }

    /** Returns the tool name patterns that all rules mount for this state. */
    resolve(scopeKey: string, state: State, ctx: RuleContext): string[] {
        let entries = this.memo.get(scopeKey);
        if (entries) {
            // Move to the end: the map doubles as a least-recently-used list.
            this.memo.delete(scopeKey);
        } else {
            entries = [];
        }
        this.memo.set(scopeKey, entries);
        if (this.memo.size > this.maxScopes) {
            const oldest = this.memo.keys().next().value;
            if (oldest !== undefined) this.memo.delete(oldest);
        }

        const out: string[] = [];
        for (let i = 0; i < this.compiled.length; i++) {
            const { rule, deps } = this.compiled[i]!;
            let patterns: readonly string[];
            if (deps) {
                const depValues = deps.map(path => getPath(state, path));
                const cached = entries[i];
                if (cached && depValues.every((value, index) => deepEqual(value, cached.depValues[index]))) {
                    patterns = cached.patterns;
                } else {
                    patterns = this.run(rule, state, ctx);
                    entries[i] = { depValues: structuredCloneSafe(depValues), patterns };
                }
            } else {
                patterns = this.run(rule, state, ctx);
            }
            for (const pattern of patterns) out.push(pattern);
        }
        return out;
    }

    /** Forgets remembered answers. Call after rules change. */
    reset(): void {
        this.memo.clear();
    }

    private run(rule: UseToolsRule, state: State, ctx: RuleContext): readonly string[] {
        try {
            if (rule.when && !evaluate(rule.when, state)) return [];
            const result = typeof rule.tools === 'function' ? rule.tools(state, ctx) : rule.tools;
            if (!result) return [];
            if (!Array.isArray(result)) throw new TypeError('tools() must return an array of tool names');
            return result.filter((name): name is string => typeof name === 'string' && name.length > 0);
        } catch (error) {
            // Fail closed: a broken rule mounts nothing.
            const wrapped = new Error(`mcp-effect: rule "${rule.name ?? 'unnamed'}" failed and mounted no tools`, { cause: error });
            this.onerror(wrapped);
            return [];
        }
    }
}

function structuredCloneSafe<T>(value: T): T {
    try {
        return structuredClone(value);
    } catch {
        return value;
    }
}

const patternCache = new Map<string, RegExp>();

function patternToRegExp(pattern: string): RegExp {
    let regex = patternCache.get(pattern);
    if (!regex) {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*');
        regex = new RegExp(`^${escaped}$`);
        if (patternCache.size > 5_000) patternCache.clear();
        patternCache.set(pattern, regex);
    }
    return regex;
}

/**
 * Turns name patterns into the sorted list of real tool names they match.
 * Names that match no registered tool are ignored.
 *
 * Pass a `cache` that lives as long as `registered` stays the same, and each
 * wildcard is matched against the registry only once.
 */
export function matchTools(patterns: Iterable<string>, registered: ReadonlySet<string>, cache?: Map<string, readonly string[]>): string[] {
    const mounted = new Set<string>();
    for (const pattern of patterns) {
        if (!pattern.includes('*')) {
            if (registered.has(pattern)) mounted.add(pattern);
            continue;
        }
        let matches = cache?.get(pattern);
        if (!matches) {
            const regex = patternToRegExp(pattern);
            const found: string[] = [];
            for (const name of registered) if (regex.test(name)) found.push(name);
            matches = found;
            if (cache) {
                if (cache.size > 5_000) cache.clear();
                cache.set(pattern, matches);
            }
        }
        for (const name of matches) mounted.add(name);
    }
    return [...mounted].sort();
}
