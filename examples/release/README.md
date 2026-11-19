# A deploy tool that needs approval

The agent can always read logs and run tests. The deploy tool exists only after a person has approved.

Point your MCP client at the gateway:

```json
{
    "mcpServers": {
        "release": { "command": "npx", "args": ["mcp-effect", "/full/path/to/examples/release/gateway.json"] }
    }
}
```

Then approve. Your own system would do this, for example when someone clicks a button:

```bash
echo '{ "global": { "deploy": { "approved": true } } }' > examples/release/state.json
```

The deploy tool appears. Set `approved` back to `false`, and it is gone again.
