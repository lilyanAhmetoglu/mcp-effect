import { afterEach, describe, expect, it } from 'vitest';

import { createGateway, type Gateway } from '../src/index.js';
import { text } from './helpers.js';

let gateway: Gateway | undefined;
afterEach(async () => {
    await gateway?.close();
});

describe('scale', () => {
    it('stays fast with 5 000 tools, 300 rules and 2 000 scopes', async () => {
        gateway = createGateway({ always: ['core_*'] });
        for (let i = 0; i < 5000; i++) {
            const group = i % 300;
            gateway.tool({ name: i < 20 ? `core_${i}` : `g${group}_tool_${i}` }, async () => text('ok'));
        }
        for (let group = 0; group < 300; group++) {
            gateway.useTools({ name: `group-${group}`, when: { [`groups.g${group}`]: true }, tools: [`g${group}_*`] });
        }

        for (let s = 0; s < 2000; s++) {
            await gateway.setState({ groups: { [`g${s % 300}`]: true } }, { scope: `tenant:${s}` });
        }

        // First pass: every scope is computed for the first time.
        let started = performance.now();
        for (let s = 0; s < 2000; s++) {
            const tools = await gateway.listTools(`tenant:${s}`);
            expect(tools.length).toBeGreaterThan(20);
            expect(tools.length).toBeLessThan(60);
        }
        const cold = (performance.now() - started) / 2000;

        // Second pass: nothing changed, so answers come from memory.
        started = performance.now();
        for (let s = 0; s < 2000; s++) await gateway.listTools(`tenant:${s}`);
        const warm = (performance.now() - started) / 2000;

        // One global change must be re-checked for all 2 000 scopes.
        started = performance.now();
        await gateway.setState({ groups: { g299: true } });
        await gateway.flush();
        const fanout = performance.now() - started;

        console.log(`scale: cold list ${cold.toFixed(3)} ms, warm list ${warm.toFixed(3)} ms, global change over 2000 scopes ${fanout.toFixed(0)} ms`);
        expect(cold).toBeLessThan(20);
        expect(warm).toBeLessThan(2);
        expect(fanout).toBeLessThan(15_000);
    });

    it('keeps memory bounded when scopes keep coming', async () => {
        gateway = createGateway({ always: ['a'], maxScopes: 100 });
        gateway.tool({ name: 'a' }, async () => text('ok'));
        for (let s = 0; s < 5000; s++) await gateway.mounted(`visitor:${s}`);
        const internal = gateway as unknown as { resolved: Map<string, unknown> };
        expect(internal.resolved.size).toBeLessThanOrEqual(100);
    });

    it('handles many calls at once while state keeps changing', async () => {
        gateway = createGateway({ scope: () => undefined });
        let ran = 0;
        gateway.tool({ name: 'gated' }, async () => {
            ran++;
            return text('ok');
        });
        gateway.useTools({ when: { open: true }, tools: ['gated'] });

        const outcomes: string[] = [];
        const work: Promise<void>[] = [];
        for (let i = 0; i < 500; i++) {
            if (i % 50 === 0) work.push(gateway.setState({ open: i % 100 === 0 }));
            work.push(
                gateway.callTool(undefined, 'gated').then(
                    () => void outcomes.push('ran'),
                    () => void outcomes.push('refused')
                )
            );
        }
        await Promise.all(work);
        expect(outcomes).toHaveLength(500);
        expect(ran).toBe(outcomes.filter(outcome => outcome === 'ran').length);
        expect(outcomes).toContain('ran');
        expect(outcomes).toContain('refused');
    });
});
