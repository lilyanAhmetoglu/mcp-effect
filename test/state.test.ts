import { describe, expect, it, vi } from 'vitest';

import { deepEqual, deepMerge, getPath, GLOBAL_SCOPE, MemoryStateStore } from '../src/index.js';

describe('getPath', () => {
    it('reads nested values by dot path', () => {
        expect(getPath({ order: { status: 'failed' } }, 'order.status')).toBe('failed');
    });
    it('returns undefined for a missing part', () => {
        expect(getPath({ order: null }, 'order.status')).toBeUndefined();
        expect(getPath({}, 'a.b.c')).toBeUndefined();
        expect(getPath('text', 'length')).toBeUndefined();
    });
    it('does not read from the prototype chain', () => {
        expect(getPath({}, 'constructor')).toBeUndefined();
        expect(getPath({}, '__proto__.polluted')).toBeUndefined();
        expect(getPath({}, 'toString')).toBeUndefined();
    });
});

describe('deepEqual', () => {
    it('compares structure, not identity', () => {
        expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
        expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
        expect(deepEqual([1, 2], [2, 1])).toBe(false);
        expect(deepEqual([], {})).toBe(false);
        expect(deepEqual(NaN, NaN)).toBe(true);
        expect(deepEqual(null, {})).toBe(false);
    });
});

describe('deepMerge', () => {
    it('merges objects, replaces arrays, and deletes on null', () => {
        const merged = deepMerge({ a: { x: 1, y: 2 }, list: [1, 2], gone: true }, { a: { y: 3 }, list: [9], gone: null });
        expect(merged).toEqual({ a: { x: 1, y: 3 }, list: [9] });
    });
    it('does not change its inputs', () => {
        const base = { a: { x: 1 } };
        deepMerge(base, { a: { x: 2 } });
        expect(base).toEqual({ a: { x: 1 } });
    });
    it('blocks prototype pollution', () => {
        const patch = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}');
        const merged = deepMerge({}, patch);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.keys(merged)).toEqual([]);
    });
});

describe('MemoryStateStore', () => {
    it('keeps one state per scope and notifies on real changes only', () => {
        const store = new MemoryStateStore({ plan: 'free' });
        const listener = vi.fn();
        store.subscribe(listener);

        store.patch('user:alice', { order: { status: 'failed' } });
        store.patch('user:alice', { order: { status: 'failed' } }); // same value: no event
        store.set(GLOBAL_SCOPE, { plan: 'free' }); // same value: no event

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith('user:alice');
        expect(store.get('user:alice')).toEqual({ order: { status: 'failed' } });
        expect(store.get('user:bob')).toEqual({});
        expect(store.get(GLOBAL_SCOPE)).toEqual({ plan: 'free' });
    });

    it('copies what it stores, so later edits by the caller do not leak in', () => {
        const store = new MemoryStateStore();
        const mine = { order: { status: 'ok' } };
        store.set('s', mine);
        mine.order.status = 'failed';
        expect(store.get('s')).toEqual({ order: { status: 'ok' } });
    });

    it('rejects state that is not a plain object', () => {
        const store = new MemoryStateStore();
        expect(() => store.set('s', [] as never)).toThrow(TypeError);
        expect(() => store.patch('s', 'x' as never)).toThrow(TypeError);
    });

    it('survives a listener that throws, and stops calling after unsubscribe', () => {
        const store = new MemoryStateStore();
        const good = vi.fn();
        store.subscribe(() => {
            throw new Error('boom');
        });
        const off = store.subscribe(good);
        store.patch('s', { a: 1 });
        off();
        store.patch('s', { a: 2 });
        expect(good).toHaveBeenCalledTimes(1);
    });

    it('deletes a scope', () => {
        const store = new MemoryStateStore();
        store.patch('s', { a: 1 });
        store.delete('s');
        expect(store.get('s')).toEqual({});
        expect(store.scopeNames()).toEqual([GLOBAL_SCOPE]);
    });
});
