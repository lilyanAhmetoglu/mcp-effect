# Config reference

The `mcp-effect` command reads one JSON file.

```bash
mcp-effect gateway.json            # serve over stdio
mcp-effect gateway.json --http     # serve over HTTP
mcp-effect gateway.json --check    # check the file and exit
```

Add this line at the top of your file to get help in your editor:

```json
{ "$schema": "https://raw.githubusercontent.com/lilyanAhmetoglu/mcp-effect/main/schema/config.schema.json" }
```

## All fields

| Field          | Type                      | Default        | What it does                                                    |
| -------------- | ------------------------- | -------------- | --------------------------------------------------------------- |
| `name`         | string                    | `mcp-effect`   | Server name shown to MCP clients.                               |
| `upstreams`    | object                    | none           | MCP servers to put behind the gateway.                          |
| `always`       | string[]                  | `[]`           | Tools that are always mounted. `*` is a wildcard.               |
| `rules`        | object[]                  | `[]`           | "When this is true, mount these tools."                         |
| `state`        | object                    | none           | Where state comes from.                                         |
| `scope`        | string                    | none           | A fixed scope for stdio mode, where there is one caller.        |
| `denied`       | `"hidden"` \| `"explain"` | `"hidden"`     | What a call to an unmounted tool gets back.                     |
| `separator`    | string                    | `__`           | Text between an upstream name and its tool name.                |
| `instructions` | string                    | none           | Extra text for the server instructions. Rule hints come after.  |
| `http`         | object                    | none           | Settings for `--http`.                                          |

Unknown fields are an error. This protects you from typos like `rule` instead of `rules`.

## `upstreams`

Each upstream has a name. Its tools are named `<name>__<tool>`.

```json
{
    "upstreams": {
        "shop": { "command": "node", "args": ["./shop-server.mjs"], "env": { "API_KEY": "${SHOP_API_KEY}" } },
        "mail": { "url": "https://mail.example.com/mcp", "headers": { "Authorization": "Bearer ${MAIL_TOKEN}" } }
    }
}
```

- `${NAME}` is replaced by the environment variable `NAME`. A missing variable is an error at start.
- A `command` upstream starts in the folder of the config file.
- A `command` upstream gets a small set of environment variables (`PATH`, `HOME`, and a few more) plus what you list in `env`. Your other secrets are not passed on.

## `rules`

```json
{
    "rules": [
        {
            "name": "refunds",
            "when": { "order.status": "failed", "order.total": { "lte": 500 } },
            "tools": ["shop__refund_order"],
            "hint": "Refund tools appear when an order has failed."
        }
    ]
}
```

A rule without `when` is always on.

### Conditions

| You write                               | It means                                |
| --------------------------------------- | --------------------------------------- |
| `{ "plan": "pro" }`                     | `plan` equals `"pro"`                   |
| `{ "a": 1, "b": 2 }`                    | both must match                         |
| `{ "plan": { "in": ["pro", "team"] } }` | `plan` is one of these                  |
| `{ "plan": { "nin": ["free"] } }`       | `plan` is none of these                 |
| `{ "plan": { "ne": "free" } }`          | `plan` does not equal `"free"`          |
| `{ "total": { "gt": 100 } }`            | also `gte`, `lt`, `lte`. Numbers only.  |
| `{ "user.id": { "exists": true } }`     | the value is set                        |
| `{ "tags": { "contains": "vip" } }`     | a list holds the value, or a text holds the part |
| `{ "any": [ ... ] }`                    | at least one condition matches          |
| `{ "all": [ ... ] }`                    | every condition matches                 |
| `{ "not": { ... } }`                    | the condition does not match            |

Paths use dots: `order.status` reads `state.order.status`. A missing value never matches, and never causes an error.

The words `all`, `any` and `not` are reserved. Do not use them as top-level state keys.

## `state`

```json
{
    "state": {
        "initial": { "maintenance": false },
        "scopes": { "user:alice": { "plan": "pro" } },
        "file": "./state.json"
    }
}
```

### The state file

```json
{
    "global": { "maintenance": false },
    "scopes": {
        "user:alice": { "order": { "status": "failed" } }
    }
}
```

The gateway reads this file again when it changes. Any program can write it.

- When the file is set, it is the source of truth. It replaces `initial` and `scopes` from the config.
- A file that is not valid JSON is ignored. The last good state stays. So a half-written file cannot open or close a tool.
- Write the file in one step if you can: write to a temp file, then rename it.

## `http`

```json
{
    "http": {
        "port": 3000,
        "clients": [
            { "tokenEnv": "ALICE_TOKEN", "scope": "user:alice" },
            { "tokenEnv": "BOB_TOKEN", "scope": "user:bob" }
        ],
        "adminTokenEnv": "MCP_EFFECT_ADMIN_TOKEN"
    }
}
```

| Field           | Default     | What it does                                                            |
| --------------- | ----------- | ----------------------------------------------------------------------- |
| `port`          | `3000`      | `0` picks a free port.                                                  |
| `host`          | `127.0.0.1` | The address to listen on.                                               |
| `path`          | `/mcp`      | The MCP endpoint.                                                       |
| `clients`       | none        | Callers. Each has a bearer token in an environment variable and a scope. |
| `adminTokenEnv` | none        | Turns on the state API. The variable holds its bearer token.            |
| `allowedHosts`  | localhost   | Host names allowed in the `Host` and `Origin` headers.                  |

Safety rules of the HTTP mode:

- With `clients`, a request without a known token gets `401`.
- Without `clients`, any program on the same machine can connect, and every caller shares the global state.
- If `host` is not loopback, `clients` and `allowedHosts` are required. The gateway will not start open to the network.
- Tokens are never written in the config file. Only the names of environment variables are.
- The gateway does not do TLS. Put it behind a reverse proxy that does.

These tokens are simple shared secrets. For OAuth, use the library and pass verified `authInfo` to `handler.fetch`.

### The state API

It exists only when `adminTokenEnv` is set. Use `global` as the scope for shared state.

```bash
# read
curl -H "Authorization: Bearer $MCP_EFFECT_ADMIN_TOKEN" http://127.0.0.1:3000/state/user:alice

# merge (null deletes a key)
curl -X PATCH -H "Authorization: Bearer $MCP_EFFECT_ADMIN_TOKEN" \
     -d '{"order": {"status": "failed"}}' http://127.0.0.1:3000/state/user:alice

# replace
curl -X PUT -H "Authorization: Bearer $MCP_EFFECT_ADMIN_TOKEN" \
     -d '{}' http://127.0.0.1:3000/state/user:alice
```

Each answer holds the new state and the tools that are now mounted:

```json
{ "scope": "user:alice", "state": { "order": { "status": "failed" } }, "tools": ["shop__get_order", "shop__refund_order"] }
```

`GET /healthz` answers `200` when the gateway is up.
