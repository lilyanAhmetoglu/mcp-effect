// The whole idea in one file. Run it with: npm run example
//
// The agent can always read logs and run tests.
// The deploy tool exists only after a person has approved.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGateway, getPath } from 'mcp-effect';

const gateway = createGateway({ always: ['read_logs', 'run_tests'] });

const say = text => ({ content: [{ type: 'text', text }] });
gateway.tool({ name: 'read_logs', description: 'Read the logs of a build' }, async ({ build }) => say(`Build ${build}: no errors in the last hour`));
gateway.tool({ name: 'run_tests', description: 'Run the tests of a build' }, async ({ build }) => say(`Build ${build}: 212 tests passed`));
gateway.tool({ name: 'deploy_to_production', description: 'Deploy a build to production' }, async ({ build }) => say(`Deployed build ${build} to production`));

// The rule. Read it like useEffect: when `deploy.approved` changes, run again.
gateway.useTools({
    deps: ['deploy.approved'],
    tools: state => (getPath(state, 'deploy.approved') === true ? ['deploy_to_production'] : []),
    hint: 'The deploy tool appears after a person has approved the release.'
});

// Connect a real MCP client. No network: the client calls the handler directly.
const handler = gateway.http();
const client = new Client({ name: 'demo', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await client.connect(
    new StreamableHTTPClientTransport(new URL('http://demo.local/mcp'), {
        fetch: (url, init) => handler.fetch(new Request(url, init))
    })
);
const names = async () => (await client.listTools()).tools.map(tool => tool.name).join(', ');

console.log('1. not approved yet        ->', await names());

try {
    await client.callTool({ name: 'deploy_to_production', arguments: { build: '42' } });
} catch (error) {
    console.log('2. deploy before approval  -> refused:', error.message);
}

// A person clicks "Approve" in your own system. Your code tells the gateway.
await gateway.setState({ deploy: { approved: true } });
console.log('3. a person approved       ->', await names());

const result = await client.callTool({ name: 'deploy_to_production', arguments: { build: '42' } });
console.log('4. deploy after approval   ->', result.content[0].text);

// The approval is used up. Your code takes it back.
await gateway.setState({ deploy: { approved: false } });
console.log('5. approval is used up     ->', await names());

await client.close();
await gateway.close();
