#!/usr/bin/env node
import { dirname, resolve } from 'node:path';

import { loadConfig } from './config.js';
import { startFromConfig } from './run.js';

const HELP = `mcp-effect: useEffect for MCP tools

Usage:
  mcp-effect <config.json>            Serve over stdio (for desktop MCP clients)
  mcp-effect <config.json> --http     Serve over HTTP (see "http" in the config)
  mcp-effect <config.json> --check    Check the config and exit

Options:
  --port <n>     HTTP port. Overrides "http.port" in the config.
  -h, --help     Show this help.
`;

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes('-h') || args.includes('--help')) {
        process.stdout.write(HELP);
        return;
    }
    let configPath: string | undefined;
    let mode: 'stdio' | 'http' = 'stdio';
    let check = false;
    let port: number | undefined;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === '--http') mode = 'http';
        else if (arg === '--check') check = true;
        else if (arg === '--port') {
            port = Number(args[++i]);
            if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('--port needs a whole number from 0 to 65535');
            mode = 'http';
        } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        else if (configPath === undefined) configPath = arg;
        else throw new Error(`unexpected argument ${arg}`);
    }
    if (!configPath) {
        process.stderr.write(HELP);
        process.exitCode = 2;
        return;
    }

    const config = await loadConfig(configPath);
    if (check) {
        process.stdout.write('config ok\n');
        return;
    }
    if (port !== undefined) config.http = { ...config.http, port };

    const running = await startFromConfig(config, { mode, baseDir: dirname(resolve(configPath)) });
    let stopping = false;
    const stop = (): void => {
        if (stopping) return;
        stopping = true;
        void running.close().finally(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (mode === 'stdio') process.stdin.on('close', stop);
}

main().catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
});
