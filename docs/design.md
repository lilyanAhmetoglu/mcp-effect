# Design notes

## The one rule

**State decides which tools exist. The model cannot change the state.**

Everything else follows from this.

## Why not let the model unlock tools?

Many gateways give the model a tool like `enable_toolset` or `search_tools`. That is good for saving tokens.
But it is not a safety rule. If a prompt injection can make the model call `refund_order`, it can also make the model call `enable_toolset` first.

In `mcp-effect` there is no such tool. State comes from your systems: a webhook, a database change, a feature flag, a person clicking "approve".

## What the MCP spec allows

The [2026-07-28 spec](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) says this about `tools/list`:

- The set of tools may be empty and may change over time.
- It must **not** vary per connection.
- It must **not** change as a side effect of other requests on the connection.
- It **may** vary by the authorization on the request.

So `mcp-effect` has exactly two kinds of state:

| Kind         | Who sees it         | Spec basis                                |
| ------------ | ------------------- | ----------------------------------------- |
| Global state | Every caller        | "may change over time"                    |
| Scope state  | One verified caller | "may vary by the authorization presented" |

There is no connection state and no session state.

### Your part of the deal

- Build the scope from **verified** auth. Never from a header the client can set freely, and never from tool arguments.
- Change state from **outside** the conversation. Do not call `setState` inside a tool handler to unlock more tools for the same caller. That would be the "side effect of another request" the spec forbids, and it would also hand control back to the model.

## Two checks, not one

1. **List.** `tools/list` returns only mounted tools.
2. **Call.** `tools/call` runs the rules again with fresh state.

The second check matters more. A client may hold an old list. A broken or hostile client may call any name it likes. The list is for the model. The call check is the lock.

By default, a call to an unmounted tool gets the same error as a call to a tool that does not exist (`-32602 Unknown tool`). The caller cannot learn which hidden tools exist. Set `denied: "explain"` if you prefer an error the model can read.

## Failing closed

- A rule that throws mounts nothing.
- A rule that returns something that is not a list mounts nothing.
- A state file that is not valid JSON is ignored. The last good state stays.
- A tool name that matches no registered tool is ignored.

## How the dependency array works

Each rule has `deps`: a list of state paths.

- For a scope, the gateway remembers the last values of the deps and the last answer of the rule.
- On the next check, it compares the values. If they are equal, it reuses the answer.
- A rule written as data (`when` + a list of tools) gets its deps from the condition.
- A function rule without `deps` runs on every check. This is like `useEffect` without a dependency array.

The comparison is by structure, not by identity. `{ a: 1 }` equals `{ a: 1 }`.

## Notifications

When state changes, the gateway waits a short time (25 ms by default) and then checks the scopes it knows.
If any tool list changed, it sends one `notifications/tools/list_changed`.

- 2026-07-28 clients get it on their `subscriptions/listen` stream.
- 2025 clients on stdio get it on the connection.
- 2025 clients on stateless HTTP get no notifications. They see the new list on their next `tools/list`.

Either way, the call check does not depend on notifications.

## Running many copies

The HTTP handler builds a fresh server per request and keeps nothing between requests.

To run several processes:

1. **Share the state.** Implement `StateStore` over a shared database.

    ```ts
    interface StateStore {
        get(scope: string): State | Promise<State>;
        set(scope: string, state: State): void | Promise<void>;
        patch?(scope: string, patch: State): void | Promise<void>; // optional atomic merge
        subscribe(listener: (scope: string) => void): () => void;
    }
    ```

    Call the listeners when **any** process writes. With Redis, use pub/sub for this.
    Without `patch`, the gateway reads, merges and writes. That is not atomic across processes, so add `patch` if two writers can touch the same scope.

2. **Share the notifications.** Pass a `ServerEventBus` to `gateway.http({ bus })`. The MCP SDK documents this interface.

Memory use is bounded. The gateway remembers at most `maxScopes` scopes (10 000 by default) and forgets the least recently used one first. A forgotten scope is simply computed again.

## What this does not protect against

- A caller that is allowed to use a tool can still misuse it. Mounting is a gate, not a review.
- If your state is wrong, the gate is wrong. Protect the code and the people that can change state.
- The built-in HTTP tokens are shared secrets. Use TLS in front, and rotate them.
