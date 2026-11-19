---
name: mcp-effect
description: Set up or change an mcp-effect gateway, which mounts MCP tools only when state allows. Use when the user wants to gate, hide, scope or conditionally expose MCP tools, or mentions mcp-effect or "useEffect for MCP tools".
---

# mcp-effect

`mcp-effect` is an MCP gateway. It sits between an MCP client and one or more MCP servers.
Rules decide which tools exist. Rules read state. Only outside code can change state.

## Before you write anything

Ask or find out:

1. Which MCP servers go behind the gateway (command and args, or URL)?
2. Which tools are always safe? These go in `always`.
3. For each risky tool: which fact must be true before it may exist? That fact is the state.
4. Who changes that fact? It must be code outside the conversation: a webhook, a database change, a person.
5. Is there one caller (stdio) or many (HTTP)? Many callers need scopes from verified auth.

## Two rules you must keep

- **Never give the model a way to change gateway state.** Do not register a tool that calls `setState`. Do not call `setState` inside a tool handler to unlock tools for the same caller.
- **Build scopes from verified auth only.** Never from tool arguments or free headers.

If the user asks for either, explain why it removes the protection, and offer an outside trigger instead.

## The config file way (any language)

Write `gateway.json`:

```json
{
    "$schema": "https://raw.githubusercontent.com/lilyanAhmetoglu/mcp-effect/main/schema/config.schema.json",
    "upstreams": { "shop": { "command": "node", "args": ["./shop-server.mjs"] } },
    "always": ["shop__get_order"],
    "rules": [
        {
            "name": "refunds",
            "when": { "order.status": "failed" },
            "tools": ["shop__refund_order"],
            "hint": "Refund tools appear when an order has failed."
        }
    ],
    "state": { "file": "./state.json" }
}
```

- Upstream tools are named `<upstream>__<tool>`.
- `*` is a wildcard: `shop__*`.
- Give every rule a `hint`. The model cannot ask for a tool it has never heard of.
- Check the file: `npx mcp-effect gateway.json --check`.
- Run it: `npx mcp-effect gateway.json` (stdio) or `npx mcp-effect gateway.json --http`.

State file shape: `{ "global": { ... }, "scopes": { "user:alice": { ... } } }`.

Condition operators: a bare value means equals. Also `eq`, `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `exists`, `contains`, and `all`, `any`, `not`.

## The library way (TypeScript or JavaScript)

```ts
import { createGateway, getPath } from 'mcp-effect';

const gateway = createGateway({
    always: ['shop__get_order'],
    scope: ({ authInfo }) => authInfo?.clientId
});
await gateway.upstream('shop', { command: 'node', args: ['./shop-server.mjs'] });
gateway.useTools({
    deps: ['order.status'],
    tools: state => (getPath(state, 'order.status') === 'failed' ? ['shop__refund_order'] : []),
    hint: 'Refund tools appear when an order has failed.'
});
gateway.stdio(); // or: const handler = gateway.http();

// From outside code only:
await gateway.setState({ order: { status: 'failed' } }, { scope: 'user:alice' });
```

`deps` works like a `useEffect` dependency array. List every state path the function reads.
A missing dep means the rule will not re-run when that value changes.

## After you set it up

Prove it works. Do not only read the config.

1. List tools with the state off. The gated tool must be missing.
2. Call the gated tool anyway. It must fail with `Unknown tool`.
3. Change the state from outside. List again. The tool must be there.
4. Change the state back. Call the tool. It must fail again.

Tell the user what you ran and what you saw.
