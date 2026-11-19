"""mcp-effect from Python.

The gateway is a separate process, so the agent can be written in any language.
This script uses the official Python MCP SDK and checks two setups:

1. stdio + a state file   (one caller, like a desktop client)
2. HTTP + bearer tokens   (two callers, each with their own state)

Run it from the repo root, after `npm install`:

    pip install "mcp>=2.3"
    python examples/python-client/demo.py

It exits with code 1 if anything is not as expected.
"""

import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from mcp import Client, MCPError, StdioServerParameters
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "dist" / "cli.js"
SHOP_SERVER = ROOT / "examples" / "shop" / "shop-server.mjs"

failures = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global failures
    if not ok:
        failures += 1
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{' -> ' + detail if detail else ''}")


async def names(client: Client) -> list[str]:
    # cache_mode="refresh": always ask the gateway, never a local cache.
    return [tool.name for tool in (await client.list_tools(cache_mode="refresh")).tools]


async def refused(client: Client, tool: str) -> bool:
    try:
        await client.call_tool(tool, {"orderId": "42"})
    except MCPError as error:
        return "Unknown tool" in str(error)
    return False


async def stdio_with_state_file() -> None:
    print("\n1. stdio + state file")
    with tempfile.TemporaryDirectory() as folder:
        state = Path(folder) / "state.json"
        state.write_text(json.dumps({"global": {"order": {"status": "paid"}}}))
        config = Path(folder) / "gateway.json"
        config.write_text(
            json.dumps(
                {
                    "upstreams": {"shop": {"command": "node", "args": [str(SHOP_SERVER)]}},
                    "always": ["shop__get_order"],
                    "rules": [{"when": {"order.status": "failed"}, "tools": ["shop__refund_order"], "hint": "Refunds appear when an order has failed."}],
                    "state": {"file": "./state.json"},
                }
            )
        )
        params = StdioServerParameters(command="node", args=[str(CLI), str(config)])
        async with Client(params) as client:
            print(f"  protocol {client.protocol_version}")
            check("hints reach the client", "Refunds appear" in (client.instructions or ""))
            check("paid: only the always-on tool", await names(client) == ["shop__get_order"], str(await names(client)))
            check("paid: refund is refused", await refused(client, "shop__refund_order"))

            # Another program changes the state. Here it is this script. We wait for the notification.
            async with client.listen(tools_list_changed=True) as changes:
                state.write_text(json.dumps({"global": {"order": {"status": "failed"}}}))
                async with asyncio.timeout(10):
                    async for _event in changes:
                        break
            check("failed: got a list_changed notification", True)
            check("failed: refund is mounted", "shop__refund_order" in await names(client), str(await names(client)))
            result = await client.call_tool("shop__refund_order", {"orderId": "42"})
            check("failed: refund runs on the real server", "Refunded order 42" in result.content[0].text, result.content[0].text)

            state.write_text(json.dumps({"global": {"order": {"status": "refunded"}}}))
            for _ in range(50):
                if "shop__refund_order" not in await names(client):
                    break
                await asyncio.sleep(0.1)
            check("refunded: refund is gone again", await names(client) == ["shop__get_order"], str(await names(client)))
            check("refunded: refund is refused again", await refused(client, "shop__refund_order"))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def admin(port: int, scope: str, method: str, body: dict | None = None) -> dict:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/state/{scope}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer admin-secret", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def as_user(port: int, token: str) -> Client:
    http = create_mcp_http_client(headers={"Authorization": f"Bearer {token}"})
    return Client(streamable_http_client(f"http://127.0.0.1:{port}/mcp", http_client=http))


async def http_with_two_users() -> None:
    print("\n2. HTTP + two users")
    port = free_port()
    env = {**os.environ, "ALICE_TOKEN": "alice-secret", "BOB_TOKEN": "bob-secret", "MCP_EFFECT_ADMIN_TOKEN": "admin-secret"}
    config = ROOT / "examples" / "multi-user" / "gateway.json"
    gateway = subprocess.Popen(["node", str(CLI), str(config), "--port", str(port)], env=env, stderr=subprocess.PIPE, text=True)
    try:
        assert gateway.stderr is not None
        line = gateway.stderr.readline()  # "[mcp-effect] serving on http://..."
        check("gateway started", "serving on" in line, line.strip())

        async with as_user(port, "alice-secret") as alice, as_user(port, "bob-secret") as bob:
            print(f"  protocol {alice.protocol_version}")
            check("start: alice sees one tool", await names(alice) == ["shop__get_order"])

            answer = admin(port, "user:alice", "PATCH", {"order": {"status": "failed"}})
            check("state API reports alice's new tools", "shop__refund_order" in answer["tools"], str(answer["tools"]))
            check("alice now sees the refund tool", "shop__refund_order" in await names(alice))
            check("bob still sees one tool", await names(bob) == ["shop__get_order"], str(await names(bob)))
            result = await alice.call_tool("shop__refund_order", {"orderId": "7"})
            check("alice can refund", "Refunded order 7" in result.content[0].text)
            check("bob cannot call alice's tool", await refused(bob, "shop__refund_order"))

            admin(port, "user:alice", "PUT", {})
            check("after reset: alice is refused too", await refused(alice, "shop__refund_order"))

        try:
            async with as_user(port, "wrong-token") as stranger:
                await names(stranger)
            check("a wrong token is rejected", False)
        except Exception:
            check("a wrong token is rejected", True)
    finally:
        gateway.terminate()
        gateway.wait(timeout=10)


async def main() -> None:
    if not CLI.exists():
        sys.exit("dist/cli.js is missing. Run `npm install` in the repo root first.")
    await stdio_with_state_file()
    await http_with_two_users()
    print(f"\n{'All checks passed.' if failures == 0 else f'{failures} check(s) failed.'}")
    sys.exit(1 if failures else 0)


asyncio.run(main())
