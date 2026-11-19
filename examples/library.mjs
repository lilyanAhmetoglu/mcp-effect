// The whole idea in one file. Run it with: npm run example
//
// It starts a gateway with three tools, connects a real MCP client to it,
// and shows how the tool list follows the state.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGateway, getPath } from 'mcp-effect';

const gateway = createGateway({
    always: ['get_order'],
    // Each caller gets its own state. Here the caller id comes from verified auth.
    scope: ({ authInfo }) => authInfo?.clientId
});

const say = text => ({ content: [{ type: 'text', text }] });
gateway.tool({ name: 'get_order', description: 'Read an order' }, async ({ id }) => say(`Order ${id}: 2 items, 59.00 EUR`));
gateway.tool({ name: 'refund_order', description: 'Refund an order' }, async ({ id }) => say(`Refunded order ${id}`));
gateway.tool({ name: 'email_customer', description: 'Email the customer' }, async ({ id }) => say(`Emailed the customer of order ${id}`));

// The rule. Read it like useEffect: when `order.status` changes, run again.
gateway.useTools({
    deps: ['order.status'],
    tools: state => (getPath(state, 'order.status') === 'failed' ? ['refund_order', 'email_customer'] : []),
    hint: 'Refund and email tools appear when an order has failed.'
});

// Connect a real MCP client as "user:alice". No network: the client calls the handler directly.
const handler = gateway.http();
const alice = { token: 'demo', clientId: 'user:alice', scopes: [] };
const client = new Client({ name: 'demo', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await client.connect(
    new StreamableHTTPClientTransport(new URL('http://demo.local/mcp'), {
        fetch: (url, init) => handler.fetch(new Request(url, init), { authInfo: alice })
    })
);
const names = async () => (await client.listTools()).tools.map(tool => tool.name).join(', ');

console.log('1. order is paid      ->', await names());

try {
    await client.callTool({ name: 'refund_order', arguments: { id: '42' } });
} catch (error) {
    console.log('2. refund while paid  -> refused:', error.message);
}

await gateway.setState({ order: { status: 'failed' } }, { scope: 'user:alice' });
console.log('3. order has failed   ->', await names());

const result = await client.callTool({ name: 'refund_order', arguments: { id: '42' } });
console.log('4. refund while failed->', result.content[0].text);

await gateway.setState({ order: { status: 'refunded' } }, { scope: 'user:alice' });
console.log('5. order is refunded  ->', await names());

await client.close();
await gateway.close();
