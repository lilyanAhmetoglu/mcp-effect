// A tiny MCP server with three tools. It stands in for a real release system.
// Run it alone with: node examples/release/release-server.mjs
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const buildInput = {
    type: 'object',
    properties: { build: { type: 'string', description: 'The build number' } },
    required: ['build']
};

const tools = [
    { name: 'read_logs', description: 'Read the logs of a build', inputSchema: buildInput },
    { name: 'run_tests', description: 'Run the tests of a build', inputSchema: buildInput },
    { name: 'deploy_to_production', description: 'Deploy a build to production', inputSchema: buildInput }
];

serveStdio(() => {
    const server = new Server({ name: 'release', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools }));
    server.setRequestHandler('tools/call', async request => {
        const { name, arguments: args } = request.params;
        const build = String(args?.build ?? '');
        if (name === 'read_logs') return { content: [{ type: 'text', text: `Build ${build}: no errors in the last hour` }] };
        if (name === 'run_tests') return { content: [{ type: 'text', text: `Build ${build}: 212 tests passed` }] };
        if (name === 'deploy_to_production') return { content: [{ type: 'text', text: `Deployed build ${build} to production` }] };
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    });
    return server;
});
