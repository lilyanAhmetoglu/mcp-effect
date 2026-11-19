import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The CLI tests run the built command, so build once before all tests. */
export default function setup(): void {
    const root = fileURLToPath(new URL('..', import.meta.url));
    execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.build.json'], {
        cwd: root,
        stdio: 'inherit'
    });
}
