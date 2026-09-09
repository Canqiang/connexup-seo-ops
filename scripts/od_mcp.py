#!/usr/bin/env python3
"""Stdio JSON-RPC client for the `open-design` MCP server registered in Claude Code.

Server command/args/env are read from ~/.claude.json (mcpServers["open-design"]),
so this works wherever `claude mcp add-json -s user open-design ...` has been run.

Usage:
  od_mcp.py config
  od_mcp.py tools
  od_mcp.py resources [substring]
  od_mcp.py read <uri>
  od_mcp.py call <tool> '<json-args>'        # "@file:path" string values are expanded
  od_mcp.py wait-run <runId> [maxSeconds]
  od_mcp.py install-ds <dir> [--check-only]
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

SERVER_NAME = "open-design"
REQUIRED_TOKENS = [
    "--bg", "--surface", "--fg", "--fg-2", "--muted", "--border", "--accent",
    "--accent-on", "--success", "--warn", "--danger", "--font-body",
    "--font-display", "--font-mono",
]


def load_server() -> dict:
    cfg_path = Path.home() / ".claude.json"
    cfg = json.loads(cfg_path.read_text("utf-8"))
    server = (cfg.get("mcpServers") or {}).get(SERVER_NAME)
    if not server:
        sys.exit(f"{SERVER_NAME} not found in {cfg_path} mcpServers; run `claude mcp get {SERVER_NAME}`")
    return server


def rpc(calls: list[tuple[str, dict]], timeout: float = 120.0) -> dict[int, dict]:
    server = load_server()
    env = dict(os.environ, **(server.get("env") or {}))
    proc = subprocess.Popen(
        [server["command"], *server.get("args", [])],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env=env, text=True,
    )
    assert proc.stdin and proc.stdout

    def send(obj: dict) -> None:
        proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        proc.stdin.flush()

    send({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {},
        "clientInfo": {"name": "seo-ops-od-mcp", "version": "1"}}})
    send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    for i, (method, params) in enumerate(calls, 1):
        send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})

    got: dict[int, dict] = {}
    deadline = time.time() + timeout
    while len(got) < len(calls) + 1 and time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(msg, dict) and "id" in msg:
            got[msg["id"]] = msg
    proc.kill()
    missing = [i for i in range(1, len(calls) + 1) if i not in got]
    if missing:
        sys.exit(f"no response for request ids {missing} (timeout {timeout}s)")
    return got


def expand_file_refs(value):
    if isinstance(value, str) and value.startswith("@file:"):
        return Path(value[len("@file:"):]).read_text("utf-8")
    if isinstance(value, dict):
        return {k: expand_file_refs(v) for k, v in value.items()}
    if isinstance(value, list):
        return [expand_file_refs(v) for v in value]
    return value


def tool_text(result: dict) -> str:
    if "error" in result:
        sys.exit(f"rpc error: {json.dumps(result['error'], ensure_ascii=False)}")
    res = result["result"]
    text = "".join(c.get("text", "") for c in res.get("content", []) if c.get("type", "text") == "text")
    if res.get("isError"):
        sys.exit(f"tool error: {text}")
    return text


def cmd_config() -> None:
    server = load_server()
    print("command:", server["command"], *server.get("args", []))
    print("OD_DATA_DIR:", (server.get("env") or {}).get("OD_DATA_DIR", "<unset>"))


def cmd_tools() -> None:
    got = rpc([("tools/list", {})])
    for t in got[1]["result"]["tools"]:
        print(t["name"])


def cmd_resources(needle: str = "") -> None:
    got = rpc([("resources/list", {})])
    for r in got[1]["result"]["resources"]:
        line = f"{r.get('uri')} | {r.get('name')}"
        if needle.lower() in line.lower():
            print(line)


def cmd_read(uri: str) -> None:
    got = rpc([("resources/read", {"uri": uri})])
    if "error" in got[1]:
        sys.exit(f"rpc error: {json.dumps(got[1]['error'], ensure_ascii=False)}")
    print("".join(c.get("text", "") for c in got[1]["result"]["contents"]))


def cmd_call(tool: str, raw_args: str) -> None:
    args = expand_file_refs(json.loads(raw_args))
    got = rpc([("tools/call", {"name": tool, "arguments": args})], timeout=300)
    print(tool_text(got[1]))


def cmd_wait_run(run_id: str, max_seconds: int = 1800) -> None:
    deadline = time.time() + max_seconds
    last = None
    while time.time() < deadline:
        got = rpc([("tools/call", {"name": "get_run", "arguments": {"runId": run_id}})], timeout=120)
        last = json.loads(tool_text(got[1]))
        status = last.get("status")
        print(f"[{time.strftime('%H:%M:%S')}] status={status}", file=sys.stderr)
        if status in ("succeeded", "failed", "canceled"):
            print(json.dumps(last, ensure_ascii=False, indent=2))
            sys.exit(0 if status == "succeeded" else 1)
        time.sleep(10)
    print(json.dumps(last, ensure_ascii=False, indent=2))
    sys.exit(f"run {run_id} not terminal after {max_seconds}s")


def validate_package(src: Path) -> dict:
    errors: list[str] = []
    manifest_path = src / "manifest.json"
    if not manifest_path.is_file():
        sys.exit(f"missing {manifest_path}")
    manifest = json.loads(manifest_path.read_text("utf-8"))
    if manifest.get("schemaVersion") != "od-design-system-project/v1":
        errors.append("manifest.schemaVersion must be od-design-system-project/v1")
    if manifest.get("id") != src.name:
        errors.append(f"manifest.id {manifest.get('id')!r} must equal folder name {src.name!r}")
    for key in ("name", "category", "description"):
        if not isinstance(manifest.get(key), str) or not manifest[key].strip():
            errors.append(f"manifest.{key} must be a non-empty string")
    files = manifest.get("files") or {}
    if files.get("design") != "DESIGN.md" or files.get("tokens") != "tokens.css":
        errors.append("manifest.files must be {design: DESIGN.md, tokens: tokens.css}")
    design = src / "DESIGN.md"
    tokens = src / "tokens.css"
    if not design.is_file():
        errors.append("DESIGN.md missing")
    else:
        body = design.read_text("utf-8")
        if not body.lstrip().startswith("# "):
            errors.append("DESIGN.md must start with a `# ` title")
        if "> Category:" not in body:
            errors.append("DESIGN.md must contain a `> Category:` line")
    if not tokens.is_file():
        errors.append("tokens.css missing")
    else:
        css = tokens.read_text("utf-8")
        for name in REQUIRED_TOKENS:
            if f"{name}:" not in css:
                errors.append(f"tokens.css missing {name}")
    if errors:
        sys.exit("package invalid:\n  - " + "\n  - ".join(errors))
    return manifest


def cmd_install_ds(src_dir: str, check_only: bool = False) -> None:
    src = Path(src_dir).resolve()
    manifest = validate_package(src)
    print(f"package ok: {manifest['id']} ({manifest['name']})")
    if check_only:
        return
    data_dir = (load_server().get("env") or {}).get("OD_DATA_DIR")
    if not data_dir:
        sys.exit("OD_DATA_DIR not set in the MCP server env")
    dest = Path(data_dir) / "design-systems" / manifest["id"]
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("DESIGN.md", "tokens.css"):
        shutil.copy2(src / name, dest / name)
    manifest["source"] = {"type": "local", "path": str(src)}
    (dest / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(f"installed to {dest}")


def main(argv: list[str]) -> None:
    if not argv:
        sys.exit(__doc__)
    cmd, rest = argv[0], argv[1:]
    if cmd == "config":
        cmd_config()
    elif cmd == "tools":
        cmd_tools()
    elif cmd == "resources":
        cmd_resources(rest[0] if rest else "")
    elif cmd == "read":
        cmd_read(rest[0])
    elif cmd == "call":
        cmd_call(rest[0], rest[1] if len(rest) > 1 else "{}")
    elif cmd == "wait-run":
        cmd_wait_run(rest[0], int(rest[1]) if len(rest) > 1 else 1800)
    elif cmd == "install-ds":
        cmd_install_ds(rest[0], check_only="--check-only" in rest)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
