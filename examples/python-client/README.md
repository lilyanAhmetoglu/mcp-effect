# mcp-effect from Python

The gateway is its own process. So your agent does not need to be written in TypeScript.

This example uses the official Python MCP SDK. It checks two setups:

1. **stdio + a state file.** One caller, like a desktop client. The script changes the file and waits for the `tools/list_changed` notification.
2. **HTTP + bearer tokens.** Two callers. Alice gets the refund tool. Bob does not, and cannot call it.

Run it from the repo root:

```bash
npm install
pip install "mcp>=2.3"
python examples/python-client/demo.py
```

You need Python 3.11 or newer. The script exits with code 1 if a check fails.
