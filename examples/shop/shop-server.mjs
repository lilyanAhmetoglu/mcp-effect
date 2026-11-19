// A tiny MCP server with three tools. It stands in for a real "shop" backend.
// Run it alone with: node examples/shop/shop-server.mjs
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const orderInput = {
    type: 'object',
    properties: { orderId: { type: 'string', description: 'The order number' } },
    required: ['orderId']
};

const tools = [
    { name: 'get_order', description: 'Read one order', inputSchema: orderInput },
    { name: 'refund_order', description: 'Refund one order in full', inputSchema: orderInput },
    { name: 'email_customer', description: 'Email the customer of an order', inputSchema: orderInput }
];

serveStdio(() => {
    const server = new Server({ name: 'shop', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools }));
    server.setRequestHandler('tools/call', async request => {
        const { name, arguments: args } = request.params;
        const orderId = String(args?.orderId ?? '');
        if (name === 'get_order') return { content: [{ type: 'text', text: `Order ${orderId}: 2 items, 59.00 EUR` }] };
        if (name === 'refund_order') return { content: [{ type: 'text', text: `Refunded order ${orderId}` }] };
        if (name === 'email_customer') return { content: [{ type: 'text', text: `Emailed the customer of order ${orderId}` }] };
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    });
    return server;
});
