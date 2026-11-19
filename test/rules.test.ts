import { describe, expect, it, vi } from 'vitest';

import { conditionPaths, evaluate, matchTools, RuleEngine } from '../src/index.js';

describe('evaluate', () => {
    const state = { order: { status: 'failed', total: 120, tags: ['vip', 'eu'] }, plan: 'pro', note: 'call back later' };

    it('treats a bare value as equality, and several paths as AND', () => {
        expect(evaluate({ 'order.status': 'failed' }, state)).toBe(true);
        expect(evaluate({ 'order.status': 'failed', plan: 'free' }, state)).toBe(false);
    });

    it('supports every operator', () => {
        expect(evaluate({ 'order.total': { gt: 100 } }, state)).toBe(true);
        expect(evaluate({ 'order.total': { gte: 120, lte: 120 } }, state)).toBe(true);
        expect(evaluate({ 'order.total': { lt: 120 } }, state)).toBe(false);
        expect(evaluate({ plan: { in: ['pro', 'team'] } }, state)).toBe(true);
        expect(evaluate({ plan: { nin: ['pro', 'team'] } }, state)).toBe(false);
        expect(evaluate({ plan: { ne: 'free' } }, state)).toBe(true);
        expect(evaluate({ plan: { eq: 'pro' } }, state)).toBe(true);
        expect(evaluate({ 'order.tags': { contains: 'vip' } }, state)).toBe(true);
        expect(evaluate({ note: { contains: 'back' } }, state)).toBe(true);
        expect(evaluate({ 'order.missing': { exists: false } }, state)).toBe(true);
        expect(evaluate({ 'order.status': { exists: true } }, state)).toBe(true);
    });

    it('never matches a number operator against a non-number', () => {
        expect(evaluate({ plan: { gt: 1 } }, state)).toBe(false);
        expect(evaluate({ 'order.missing': { lt: 1 } }, state)).toBe(false);
    });

    it('supports all, any and not', () => {
        expect(evaluate({ any: [{ plan: 'free' }, { plan: 'pro' }] }, state)).toBe(true);
        expect(evaluate({ all: [{ plan: 'pro' }, { 'order.total': { gt: 500 } }] }, state)).toBe(false);
        expect(evaluate({ not: { plan: 'free' } }, state)).toBe(true);
        expect(evaluate({ not: { plan: 'pro' } }, state)).toBe(false);
    });

    it('is false for missing state, never an error', () => {
        expect(evaluate({ 'a.b.c': 1 }, {})).toBe(false);
    });

    it('lists the paths a condition reads', () => {
        expect([...conditionPaths({ any: [{ a: 1 }, { not: { 'b.c': 2 } }], d: { gt: 1 } })].sort()).toEqual(['a', 'b.c', 'd']);
    });
});

describe('matchTools', () => {
    const registered = new Set(['shop__get_order', 'shop__refund_order', 'mail__send', 'a.b']);

    it('matches exact names and wildcards, sorted, without duplicates', () => {
        expect(matchTools(['shop__*', 'shop__get_order', 'mail__send'], registered)).toEqual(['mail__send', 'shop__get_order', 'shop__refund_order']);
        expect(matchTools(['*'], registered)).toHaveLength(4);
    });

    it('ignores names that are not registered', () => {
        expect(matchTools(['nope', 'nope__*'], registered)).toEqual([]);
    });

    it('treats regex characters in a pattern as plain text', () => {
        expect(matchTools(['a.b'], new Set(['a.b', 'axb']))).toEqual(['a.b']);
        expect(matchTools(['a.*'], new Set(['a.b', 'axb']))).toEqual(['a.b']);
        expect(matchTools(['(.+)+$'], new Set(['aaaa']))).toEqual([]);
    });
});

describe('RuleEngine', () => {
    it('re-runs a rule only when its deps change, like a dependency array', () => {
        const engine = new RuleEngine();
        const tools = vi.fn((state: Record<string, any>) => (state.order?.status === 'failed' ? ['refund'] : []));
        engine.add({ deps: ['order.status'], tools });

        expect(engine.resolve('s', { order: { status: 'ok' } }, { scope: 's' })).toEqual([]);
        expect(engine.resolve('s', { order: { status: 'ok' }, other: 1 }, { scope: 's' })).toEqual([]);
        expect(tools).toHaveBeenCalledTimes(1);

        expect(engine.resolve('s', { order: { status: 'failed' } }, { scope: 's' })).toEqual(['refund']);
        expect(tools).toHaveBeenCalledTimes(2);
    });

    it('keeps answers apart per scope', () => {
        const engine = new RuleEngine();
        engine.add({ when: { flag: true }, tools: ['x'] });
        expect(engine.resolve('a', { flag: true }, { scope: 'a' })).toEqual(['x']);
        expect(engine.resolve('b', { flag: false }, { scope: 'b' })).toEqual([]);
        expect(engine.resolve('a', { flag: true }, { scope: 'a' })).toEqual(['x']);
    });

    it('runs a function rule without deps on every check', () => {
        const engine = new RuleEngine();
        const tools = vi.fn(() => ['x']);
        engine.add({ tools });
        engine.resolve('s', {}, { scope: 's' });
        engine.resolve('s', {}, { scope: 's' });
        expect(tools).toHaveBeenCalledTimes(2);
    });

    it('fails closed: a rule that throws mounts nothing and reports the error', () => {
        const onerror = vi.fn();
        const engine = new RuleEngine(100, onerror);
        engine.add({
            name: 'broken',
            tools: () => {
                throw new Error('boom');
            }
        });
        engine.add({ tools: () => 'not-an-array' as never });
        engine.add({ tools: ['ok'] });
        expect(engine.resolve('s', {}, { scope: 's' })).toEqual(['ok']);
        expect(onerror).toHaveBeenCalledTimes(2);
        expect(onerror.mock.calls[0]![0].message).toContain('broken');
    });

    it('combines "when" with a tools function and accepts falsy results', () => {
        const engine = new RuleEngine();
        engine.add({ when: { on: true }, deps: ['n'], tools: state => (state.n ? [`t${state.n}`] : null) });
        expect(engine.resolve('s', { on: false, n: 1 }, { scope: 's' })).toEqual([]);
        expect(engine.resolve('s', { on: true, n: 1 }, { scope: 's' })).toEqual(['t1']);
        expect(engine.resolve('s', { on: true, n: 0 }, { scope: 's' })).toEqual([]);
    });

    it('does not let memory grow past maxScopes', () => {
        const engine = new RuleEngine(3);
        const tools = vi.fn(() => ['x']);
        engine.add({ deps: ['v'], tools });
        for (const scope of ['a', 'b', 'c', 'd']) engine.resolve(scope, { v: 1 }, { scope });
        engine.resolve('a', { v: 1 }, { scope: 'a' }); // "a" was evicted, so it runs again
        engine.resolve('d', { v: 1 }, { scope: 'd' }); // "d" is still remembered
        expect(tools).toHaveBeenCalledTimes(5);
    });

    it('rejects rules that are not well formed', () => {
        const engine = new RuleEngine();
        expect(() => engine.add({ tools: 'x' as never })).toThrow(/tools/);
        expect(() => engine.add({ tools: [], deps: 'x' as never })).toThrow(/deps/);
        expect(() => engine.add({ tools: [], when: [] as never })).toThrow(/when/);
    });
});
