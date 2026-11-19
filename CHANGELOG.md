# Changelog

## Unreleased

- Fixed: an upstream's own protocol metadata (its server name) no longer passes through to the client.
- Added a Python client example and a multi-user HTTP example.
- Added a release workflow for npm.
- The README, the diagrams and the main example now use an approval-gated deploy tool. Added `examples/release`.

## 0.1.0

First release.

- `createGateway` with `useTools` rules, as functions or as data.
- Global state and per-caller scopes.
- Call-time checks for every tool call.
- Upstream MCP servers over stdio and Streamable HTTP.
- Serving over stdio and HTTP, for MCP 2026-07-28 and the 2025 handshake.
- The `mcp-effect` command with a JSON config, a watched state file, and a state API.
