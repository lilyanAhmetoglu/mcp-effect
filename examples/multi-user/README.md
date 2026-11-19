# Many users over HTTP

Each caller has a bearer token and a scope. State is per scope, so each caller gets their own tools.

Start the gateway:

```bash
export ALICE_TOKEN=alice-secret
export BOB_TOKEN=bob-secret
export MCP_EFFECT_ADMIN_TOKEN=admin-secret
npx mcp-effect examples/multi-user/gateway.json --http
```

Mark Alice's order as failed. This is what your own backend would do:

```bash
curl -X PATCH http://127.0.0.1:3000/state/user:alice \
     -H "Authorization: Bearer $MCP_EFFECT_ADMIN_TOKEN" \
     -d '{"order": {"status": "failed"}}'
```

The answer lists Alice's tools. The refund tool is now in it. Bob's list did not change.

Use real, long, random tokens outside of a demo. See the [config reference](../../docs/config.md#http).

[`examples/python-client/demo.py`](../python-client/demo.py) runs this whole flow as a test.
