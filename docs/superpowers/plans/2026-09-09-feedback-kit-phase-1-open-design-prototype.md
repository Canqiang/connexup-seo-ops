# Feedback Kit Phase 1 (OpenDesign Prototype) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get a reviewable single-page HTML prototype of the five feedback patterns out of OpenDesign, driven by a `seo-ops` design system derived from `web/src/index.css`, and hand the user a preview URL.

**Architecture:** OpenDesign runs locally as a desktop app; Claude Code talks to it through the user-scope stdio MCP server `open-design` (config in `~/.claude.json`). A small Python helper wraps that MCP server so every step is a shell command. The design system is a three-file package copied into OpenDesign's user design-systems folder; OpenDesign re-reads that folder on every listing, no restart needed. The prototype is produced by OpenDesign's own `frontend-design` skill inside an OpenDesign project, then archived into `docs/evidence/`.

**Tech Stack:** Python 3 stdlib (JSON-RPC over stdio), OpenDesign 0.22 MCP tools (`create_project`, `start_run`, `get_run`, `list_files`, `get_file`), plain CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-09-09-feedback-consistency-design.md` (sections 4 and 7, appendices A and B)

## Global Constraints

- OpenDesign user design-systems root: `~/Library/Application Support/Open Design/namespaces/release-stable/data/design-systems/` (read from `OD_DATA_DIR` in the MCP env, never hardcoded in code).
- Design system id is exactly `seo-ops`; folder name and `manifest.id` must match.
- `manifest.schemaVersion` is exactly `od-design-system-project/v1`; `files.design` is `DESIGN.md`; `files.tokens` is `tokens.css`.
- Token values are copied verbatim from `web/src/index.css`; the only new values are `--accent-active` and `--focus-ring` (spec 4.1 table).
- The run uses `skill: "frontend-design"`, `agent: "claude"`, Claude Code CLI default model. `requestId` is a fresh UUID generated once and reused on retry.
- A failed run is reported, never auto-retried (spec 6).
- Copy in appendix B of the spec must appear verbatim in the prototype; the reload button is `重新载入`.
- No `web/` source changes in this phase.
- Commits: Conventional Commits prefix, end with the session trailer block used by earlier commits.

---

## File Structure

| Path | Responsibility |
|---|---|
| `scripts/od_mcp.py` | Stdio JSON-RPC client for the `open-design` MCP server. Subcommands: `config`, `tools`, `resources`, `read`, `call`, `wait-run`, `install-ds`. Reads server config from `~/.claude.json`. |
| `docs/design/open-design/seo-ops/manifest.json` | Design-system package manifest (`od-design-system-project/v1`). |
| `docs/design/open-design/seo-ops/DESIGN.md` | Design prose OpenDesign feeds to its agent: existing visual language, dialog skeleton, buttons, anti-patterns. |
| `docs/design/open-design/seo-ops/tokens.css` | A1/A2 tokens mapped from `index.css` plus C-layer extensions with the original names. |
| `docs/evidence/2026-09-09-feedback-kit/prompt.md` | Exact prompt sent to `start_run`. |
| `docs/evidence/2026-09-09-feedback-kit/run.json` | Project id, design-system id, requestId, runId, final status, previewUrl. |
| `docs/evidence/2026-09-09-feedback-kit/prototype/` | Archived prototype files pulled with `get_file`. |
| `docs/evidence/2026-09-09-feedback-kit/check_prototype.py` | Acceptance check: required sections and copy present, no external resources. |

---

### Task 1: OpenDesign MCP helper script

**Files:**
- Create: `scripts/od_mcp.py`

**Interfaces:**
- Consumes: `~/.claude.json` → `mcpServers["open-design"]` (`command`, `args`, `env`).
- Produces: CLI used by every later task:
  - `python3 scripts/od_mcp.py config` → prints command and `OD_DATA_DIR`.
  - `python3 scripts/od_mcp.py resources [substring]` → one `uri | name` per line.
  - `python3 scripts/od_mcp.py call <tool> '<json>'` → prints the tool's text content; string values of the form `@file:<path>` are replaced with that file's content before sending; exit 1 when the tool reports an error.
  - `python3 scripts/od_mcp.py wait-run <runId> [maxSeconds]` → polls `get_run` every 10 s, prints the final JSON, exit 0 on `succeeded`, 1 otherwise.
  - `python3 scripts/od_mcp.py install-ds <dir> [--check-only]` → validates the package and copies it to `$OD_DATA_DIR/design-systems/<id>/`, rewriting `source.path` in the copied manifest to the absolute source dir.

- [ ] **Step 1: Verify the helper does not exist yet**

Run: `python3 scripts/od_mcp.py config`
Expected: `python3: can't open file '.../scripts/od_mcp.py': [Errno 2] No such file or directory`

- [ ] **Step 2: Write the helper**

```python
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
```

- [ ] **Step 3: Verify config resolution and a live tool call**

Run: `python3 scripts/od_mcp.py config`
Expected: two lines, `command: /Applications/Open Design.app/...daemon-cli.mjs mcp` and `OD_DATA_DIR: /Users/.../Open Design/namespaces/release-stable/data`

Run: `python3 scripts/od_mcp.py call list_projects '{}'`
Expected: JSON text containing `"projects"` (currently `[]`).

Run: `python3 scripts/od_mcp.py resources design-systems/agentic`
Expected: one line `od://design-systems/agentic/DESIGN.md | Design system: Agentic`

- [ ] **Step 4: Verify the `@file:` expansion and error path**

Run: `printf 'hello' > /tmp/od_mcp_probe.txt && python3 scripts/od_mcp.py call get_project '{"project":"@file:/tmp/od_mcp_probe.txt"}'; echo "exit=$?"`
Expected: a `tool error:` or `rpc error:` line mentioning no project named `hello`, and `exit=1`.

- [ ] **Step 5: Commit**

```bash
git add scripts/od_mcp.py
git commit -m "chore: add OpenDesign MCP helper script"
```

---

### Task 2: `seo-ops` design-system package

**Files:**
- Create: `docs/design/open-design/seo-ops/manifest.json`
- Create: `docs/design/open-design/seo-ops/DESIGN.md`
- Create: `docs/design/open-design/seo-ops/tokens.css`

**Interfaces:**
- Consumes: `python3 scripts/od_mcp.py install-ds <dir> [--check-only]`, `python3 scripts/od_mcp.py resources seo-ops` from Task 1.
- Produces: an OpenDesign design system whose resource URI is `od://design-systems/<DS_ID>/DESIGN.md`. `<DS_ID>` is either `seo-ops` or `user:seo-ops`; Task 3 copies whichever the listing prints.

- [ ] **Step 1: Verify the package is rejected while incomplete**

Run: `mkdir -p docs/design/open-design/seo-ops && python3 scripts/od_mcp.py install-ds docs/design/open-design/seo-ops --check-only; echo "exit=$?"`
Expected: `missing .../manifest.json` and `exit=1`

- [ ] **Step 2: Write `manifest.json`**

```json
{
  "schemaVersion": "od-design-system-project/v1",
  "id": "seo-ops",
  "name": "SEO Ops",
  "category": "Productivity & SaaS",
  "description": "Connexup SEO Ops internal operations console. Porcelain-grey canvas, white cards, ink-blue text, orange primary action, stamp-style statuses. Chinese UI, desktop 1180px and up.",
  "source": {
    "type": "local",
    "path": "/Users/xander/git_repo/connexup-seo-ops/docs/design/open-design/seo-ops"
  },
  "files": {
    "design": "DESIGN.md",
    "tokens": "tokens.css"
  }
}
```

- [ ] **Step 3: Write `tokens.css`**

```css
/* design-systems/seo-ops/tokens.css
 * Derived from web/src/index.css (:root) on 2026-09-09. Values are verbatim
 * except --accent-active and --focus-ring, which index.css does not define.
 */

:root {
  /* A1 identity */
  --bg: #f5f7f9;                /* --paper */
  --surface: #ffffff;           /* --card */
  --surface-warm: #e8eff5;      /* --paper-blue */
  --fg: #19324a;                /* --ink */
  --fg-2: #4f6578;              /* --ink-2 */
  --muted: #8394a4;             /* --muted */
  --meta: #205d7b;              /* --brand-ink */
  --border: #d5dfe7;            /* --line */
  --border-soft: var(--border); /* no lighter line in the existing palette */
  --accent: #c8731a;            /* --accent, button.primary */
  --accent-on: #ffffff;
  --accent-hover: #9d5712;      /* button.primary:hover */
  --accent-active: #7f4610;

  /* A2 semantic */
  --success: #26765b;           /* --ok */
  --warn: #c8731a;              /* --accent doubles as warning (credit-warning) */
  --danger: #b4372e;            /* --bad */

  /* Typography */
  --font-display: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  --font-body: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
  --text-xs: 10px;              /* .section-code / .eyebrow */
  --text-sm: 12px;
  --text-base: 14px;            /* body */
  --text-lg: 16px;
  --text-xl: 18px;              /* dialog h4 */
  --text-2xl: 24px;
  --text-3xl: 32px;
  --text-4xl: 40px;
  --leading-body: 1.65;         /* body */
  --leading-tight: 1.2;
  --tracking-display: 0;

  /* Spacing on a 4px grid */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;
  --section-y-desktop: 48px;
  --section-y-tablet: 40px;
  --section-y-phone: 32px;

  /* Shape and elevation */
  --radius-sm: 4px;
  --radius-md: 8px;             /* button, .error */
  --radius-lg: 8px;             /* cards stay square-ish; never larger */
  --radius-pill: 9999px;
  --elev-flat: none;
  --elev-ring: 0 0 0 1px var(--border);
  --elev-raised: 0 24px 70px rgb(25 50 74 / 22%);   /* .operation-confirm-dialog */
  --focus-ring: 0 0 0 3px #e7f2f7;

  /* Motion */
  --motion-fast: 120ms;
  --motion-base: 200ms;
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);

  /* Layout */
  --container-max: 1380px;      /* .task-detail-layout */
  --container-gutter-desktop: 32px;
  --container-gutter-tablet: 24px;
  --container-gutter-phone: 16px;

  /* C-layer extensions: original seo-ops names, kept so the prototype can
     reference the same vocabulary the React app uses. */
  --brand: #37799a;
  --brand-ink: #205d7b;
  --brand-soft: #e7f2f7;
  --line-strong: #b9c9d6;
  --accent-soft: #fff5e8;
  --ok-soft: #e5f2ed;
  --bad-soft: #f9e9e7;
  --ai: #6b46a8;
  --ai-soft: #f0e9f9;
}
```

- [ ] **Step 4: Write `DESIGN.md`**

```markdown
# SEO Ops

> Category: Productivity & SaaS
> Connexup 内部 SEO 运营控制台的现有视觉语言。本文件描述的是「已经存在的样子」，不是新方向：生成任何界面时延续它，不要重新发明。

## 1. Visual Theme & Atmosphere

内部运营台账：瓷灰底、白卡片、墨蓝文字、橙色主按钮、戳记式状态。密度偏高、克制、可扫读。中文界面，桌面优先（最小宽度 1180px），不做移动端适配。

- **Visual style:** dense operational, calm, print-like
- **Color stance:** light surfaces, one warm accent, semantic colors only for state
- **Design intent:** 让操作员一眼分清「信息」「可执行」「危险 / 不可逆」三类内容。

## 2. Color

- **Background:** `#f5f7f9` — 瓷灰页面底（`--bg`）。
- **Surface:** `#ffffff` — 白卡片、对话框（`--surface`）。
- **Surface warm:** `#e8eff5` — 次级面板底（`--surface-warm`）。
- **Text:** `#19324a` — 墨蓝黑正文（`--fg`）；次级 `#4f6578`（`--fg-2`）；弱化 `#8394a4`（`--muted`）。
- **Border:** `#d5dfe7` — 默认分割线（`--border`）；强调边 `#b9c9d6`（`--line-strong`）。
- **Accent / Primary action:** `#c8731a` 橙 — 只用于主按钮和「需要注意」的提示；hover `#9d5712`。
- **Brand blue:** `#37799a` — 链接、眉标、信息类强调（`--brand`）；深色 `#205d7b`（`--brand-ink`）；浅底 `#e7f2f7`（`--brand-soft`）。
- **Success:** `#26765b`，浅底 `#e5f2ed`。
- **Warning:** 复用橙 `#c8731a`，浅底 `#fff5e8`。
- **Danger:** `#b4372e`，浅底 `#f9e9e7`。
- **AI:** `#6b46a8`，浅底 `#f0e9f9` — 只标记 AI 生成内容。

语义色面积控制在 5% 以内；大面积永远是灰底 + 白卡片。

## 3. Typography

- **Families:** 正文与标题都用 `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif`；眉标、代码、ID 用 `ui-monospace, "SF Mono", Menlo, monospace`。
- **Scale:** 10 / 12 / 14 / 16 / 18 / 24 / 32 / 40 px；正文 14px，行高 1.65。
- **眉标（section-code / eyebrow）:** 10px 等宽、600 字重、`letter-spacing: 0.16em`、颜色 `#205d7b`、全大写英文，如 `LOCAL FALCON / PAID SCAN`。
- 标题不加装饰；对话框标题 18px。

## 4. Spacing & Grid

- 4px 基准；常用 8 / 12 / 16 / 20 / 24 / 32 / 48。
- 卡片内边距 18–22px；对话框 header / footer 各 18px 22px。
- 内容最大宽 1380px，左侧固定导航栏。

## 5. Layout & Composition

- 页面 = 眉标 + 标题 + 一句摘要，然后是卡片或表格。
- 信息用表格和 `dl` 参数表呈现，不用大图和插画。
- 层级靠留白和 1px 分割线，不靠阴影；阴影只给浮层。

## 6. Components

- **Button:** 高 34–42px，8px 圆角，1px 边。默认白底灰字；`primary` 橙底白字 500 字重；`quiet` 透明底灰字；`danger-button` 白底红字红边。禁用态灰底白字。
- **Stamp（状态戳）:** 小号大写文字 + 浅色底 + 同色系深色字，矩形，不用圆角药丸。
- **Confirm dialog（operation-confirm-dialog）:** 640px 宽（人工对账 720px）；白底、1px `#b9c9d6` 边、阴影 `0 24px 70px rgb(25 50 74 / 22%)`。结构固定：
  - header：左边眉标 + 18px 标题，右边 34px 的 `×` 关闭按钮；底部 1px 分割线；
  - body：后果说明段落；可选参数表（`dl`）或二次输入；错误提示放在这里，红字红底；
  - footer：右对齐，`quiet` 取消 + 主按钮；底色 `#fbfcfd`，顶部 1px 分割线。不可逆操作的主按钮用 danger 色。
- **Notice:** 页级提示是一条 8px 12px 内边距、8px 圆角、浅色底、同色系文字的横条；success 用绿、error 用红、warning 用橙。
- **Empty state:** 最小高 116px，居中，灰字 13px，底色 `#fbfcfd`。
- **Loading:** 文本 `加载中…`，配 `role="status"`。骨架块用 `breathe` 呼吸动画（opacity 1 → 0.25 → 1）。

## 7. Motion & Interaction

- 过渡 120–200ms，`cubic-bezier(0.2, 0, 0, 1)`。
- 浮层进入：轻微位移 + 淡入；不做缩放弹跳。
- `prefers-reduced-motion: reduce` 下所有动画静止，只保留状态变化。

## 8. Voice & Brand

- 全部中文，短句，陈述事实和后果，不用感叹号。
- 危险操作的文案先说后果再问确认，例如「删除空白草稿后无法恢复，确认删除？」。
- 英文只出现在眉标、ID 和技术名词（GBP、FBR、Core AI、Local Falcon、revision）。

## 9. Anti-patterns

- 渐变、毛玻璃、大圆角（>8px）、彩色阴影、装饰性插画或图标行。
- 用颜色代替文字表达状态。
- 点击遮罩关闭确认对话框；按钮文案「OK」「Yes」。
- 引入外部字体、图标库、脚本库。
```

- [ ] **Step 5: Validate the package offline**

Run: `python3 scripts/od_mcp.py install-ds docs/design/open-design/seo-ops --check-only`
Expected: `package ok: seo-ops (SEO Ops)`

- [ ] **Step 6: Install into OpenDesign and confirm it is listed**

Run: `python3 scripts/od_mcp.py install-ds docs/design/open-design/seo-ops`
Expected: `installed to /Users/.../data/design-systems/seo-ops`

Run: `python3 scripts/od_mcp.py resources seo-ops`
Expected: exactly one line whose URI ends in `/seo-ops/DESIGN.md`, for example `od://design-systems/seo-ops/DESIGN.md | Design system: SEO Ops` or `od://design-systems/user:seo-ops/DESIGN.md | Design system: SEO Ops`. Record the id segment between `design-systems/` and `/DESIGN.md` as `DS_ID` for Task 3.

If nothing is listed: quit and reopen the OpenDesign app once, rerun the `resources` command. If still nothing, stop and report; do not edit files under the OpenDesign data dir by hand.

- [ ] **Step 7: Commit**

```bash
git add docs/design/open-design/seo-ops
git commit -m "docs: add seo-ops OpenDesign design system package"
```

---

### Task 3: Create the OpenDesign project and run the prototype

**Files:**
- Create: `docs/evidence/2026-09-09-feedback-kit/prompt.md`
- Create: `docs/evidence/2026-09-09-feedback-kit/run.json`

**Interfaces:**
- Consumes: `DS_ID` from Task 2 step 6; helper subcommands `call` and `wait-run`.
- Produces: `run.json` with keys `projectId`, `projectName`, `designSystemId`, `requestId`, `runId`, `status`, `previewUrl`. Task 4 reads `projectId`.

- [ ] **Step 1: Write the prompt file (verbatim from spec appendices A and B)**

```markdown
为「SEO Ops」内部运营控制台制作一页「反馈模式套件」原型，文件名 index.html，桌面 1180px 起，只使用设计系统 seo-ops 的 tokens.css 变量，不引入任何外部字体、图标或脚本库。页面顶部一段说明，然后五个区块，每个区块把所有变体并排静态展示（不需要点击才能看到）。每个区块用 `<section id="…">` 包裹，id 依次为 confirm-dialog、conflict-banner、notice、loading、empty-state，并各有一个 h2 标题。

1）确认对话框（confirm-dialog）：三个真实案例（删除空白草稿、归档商户、标记 Core AI 未创建运行），外加一个「提交中」busy 态和一个「提交失败」带错误的态。结构固定为：眉标（等宽小字）+ 标题 + 关闭 ×；正文；底部「取消」（quiet）+ 危险确认按钮。
2）冲突横幅（conflict-banner）：请求返回 409 之后显示在页面顶部，唯一动作是「重新载入」，说明写操作已禁用；给出两条真实文案的版本和一个 busy 态。
3）提示（notice）：error / success / warning 三种语气，各有页级和对话框内两种位置。
4）加载（loading）：列表骨架、详情骨架、按钮 busy；骨架用轻微呼吸动画，并在 prefers-reduced-motion 下静止。
5）空态（empty-state）：带主操作按钮和不带主操作两种。

所有文案使用下面给出的原句，不要改写。整体延续现有语言：瓷灰底、白卡片、墨蓝文字、橙色主按钮、戳记式状态，不要引入渐变、毛玻璃或大圆角。

必须原样使用的文案：
- 删除：“误建空白草稿”没有任何同步、任务、分析或审计历史。删除空白草稿后无法恢复，确认删除？
- 归档：归档会关闭自动分析并停止创建新的执行；3 个待办及全部历史记录会保留。任何进行中、待审核或同步中的工作都必须先处理完成。确认归档“示例商户”？
- 标记未创建：请再次确认：Core AI 中没有创建本次运行。确认后本次分析会标记失败，之后才能重新发起诊断。
- 409（任务）：任务已变更，请刷新后再操作。
- 409（Plan）：服务器 revision 已变化，旧 checksum 已失效。请重新载入后审阅。
- 重新载入按钮：重新载入
- 取消按钮：取消
- 空态：当前筛选下没有商户。 / 当前查询条件下没有任务。 / 暂无事件记录。 / 尚未发起分析。第一次分析会在这里生成报告和任务提案。
- 加载文本：加载中…
- 成功提示示例：已保存。
- 错误提示示例：请求校验失败：商户名称不能为空
- 警告提示示例：此操作将消耗 Local Falcon credits
```

Save it as `docs/evidence/2026-09-09-feedback-kit/prompt.md` (create the directory first with `mkdir -p`).

- [ ] **Step 2: Create the project**

Run:
```bash
python3 scripts/od_mcp.py call create_project '{"name":"seo-ops 反馈模式套件","id":"seo-ops-feedback-kit","designSystem":"<DS_ID>"}'
```
Expected: JSON containing `"id": "seo-ops-feedback-kit"` (or the id OpenDesign derived) and a `conversationId`. If the response says the design system is unknown, go back to Task 2 step 6 and copy `DS_ID` exactly as listed.

Then confirm the attachment:
```bash
python3 scripts/od_mcp.py call get_project '{"project":"seo-ops-feedback-kit"}'
```
Expected: the project JSON shows the `seo-ops` design system id in its active design-system field.

- [ ] **Step 3: Start the run**

Run:
```bash
REQ_ID=$(python3 -c 'import uuid; print(uuid.uuid4())'); echo "$REQ_ID"
python3 scripts/od_mcp.py call start_run "{\"project\":\"seo-ops-feedback-kit\",\"skill\":\"frontend-design\",\"agent\":\"claude\",\"requestId\":\"$REQ_ID\",\"prompt\":\"@file:docs/evidence/2026-09-09-feedback-kit/prompt.md\"}"
```
Expected: JSON containing `"runId"`. Copy `REQ_ID` and `runId`. If the call fails after the response was lost, rerun with the same `REQ_ID` (OpenDesign de-duplicates on it); never generate a second id for the same run.

- [ ] **Step 4: Wait for the run**

Run: `python3 scripts/od_mcp.py wait-run <runId> 1800`
Expected: status lines on stderr every 10 s, then the final JSON with `"status": "succeeded"` and a `"previewUrl"`. A typical run takes 3 to 10 minutes.

If the final status is `failed` or `canceled`: write `run.json` with that status and the `agentMessage` from the output, commit it, and stop. Report the message to the user. Do not rerun.

- [ ] **Step 5: Record `run.json`**

```json
{
  "projectId": "seo-ops-feedback-kit",
  "projectName": "seo-ops 反馈模式套件",
  "designSystemId": "<DS_ID>",
  "skill": "frontend-design",
  "agent": "claude",
  "requestId": "<REQ_ID>",
  "runId": "<runId>",
  "status": "succeeded",
  "previewUrl": "<previewUrl from wait-run output>",
  "startedAt": "<ISO timestamp when start_run was called>"
}
```
Fill every angle-bracket value from the actual outputs above; the file must contain no angle brackets when committed.

- [ ] **Step 6: Commit**

```bash
git add docs/evidence/2026-09-09-feedback-kit/prompt.md docs/evidence/2026-09-09-feedback-kit/run.json
git commit -m "docs: record OpenDesign feedback-kit prototype run"
```

---

### Task 4: Archive the prototype and run the acceptance check

**Files:**
- Create: `docs/evidence/2026-09-09-feedback-kit/check_prototype.py`
- Create: `docs/evidence/2026-09-09-feedback-kit/prototype/index.html` (plus any sibling CSS/JS the run produced)

**Interfaces:**
- Consumes: `projectId` from `run.json`; helper `call list_files` / `get_file`.
- Produces: archived prototype files and a passing acceptance script. These are the porting inputs for phase 2.

- [ ] **Step 1: Write the acceptance check**

```python
#!/usr/bin/env python3
"""Acceptance check for the OpenDesign feedback-kit prototype (spec section 7, phase 1)."""
from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROTO = HERE / "prototype"

REQUIRED_SECTIONS = ["confirm-dialog", "conflict-banner", "notice", "loading", "empty-state"]
REQUIRED_COPY = [
    "没有任何同步、任务、分析或审计历史。删除空白草稿后无法恢复，确认删除？",
    "归档会关闭自动分析并停止创建新的执行；",
    "任何进行中、待审核或同步中的工作都必须先处理完成。确认归档",
    "请再次确认：Core AI 中没有创建本次运行。确认后本次分析会标记失败，之后才能重新发起诊断。",
    "任务已变更，请刷新后再操作。",
    "服务器 revision 已变化，旧 checksum 已失效。请重新载入后审阅。",
    "重新载入",
    "当前筛选下没有商户。",
    "当前查询条件下没有任务。",
    "暂无事件记录。",
    "尚未发起分析。第一次分析会在这里生成报告和任务提案。",
    "加载中…",
]
EXTERNAL = re.compile(r"""(?:<link[^>]+href|<script[^>]+src|@import\s+(?:url\()?|url\()\s*["']?https?://""", re.I)


def main() -> int:
    html_path = PROTO / "index.html"
    if not html_path.is_file():
        print(f"FAIL: {html_path} missing")
        return 1
    files = [p for p in PROTO.rglob("*") if p.is_file() and p.suffix in {".html", ".css", ".js"}]
    corpus = "\n".join(p.read_text("utf-8", errors="replace") for p in files)
    html = html_path.read_text("utf-8", errors="replace")
    failures: list[str] = []

    for sid in REQUIRED_SECTIONS:
        if not re.search(rf"""<section[^>]*\bid\s*=\s*["']{sid}["']""", html):
            failures.append(f"missing <section id=\"{sid}\">")
    for text in REQUIRED_COPY:
        if text not in html:
            failures.append(f"missing copy: {text}")
    for m in EXTERNAL.finditer(corpus):
        failures.append(f"external resource: {corpus[m.start():m.start() + 80]!r}")
    if "prefers-reduced-motion" not in corpus:
        failures.append("no prefers-reduced-motion rule")

    if failures:
        print("FAIL")
        for f in failures:
            print(" -", f)
        return 1
    print(f"PASS: {len(files)} file(s), {len(REQUIRED_SECTIONS)} sections, {len(REQUIRED_COPY)} copy strings, no external resources")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Verify the check fails before the archive exists**

Run: `python3 docs/evidence/2026-09-09-feedback-kit/check_prototype.py; echo "exit=$?"`
Expected: `FAIL: .../prototype/index.html missing` and `exit=1`

- [ ] **Step 3: Pull the prototype files**

Run:
```bash
python3 scripts/od_mcp.py call list_files '{"project":"seo-ops-feedback-kit"}'
```
Expected: JSON listing at least `index.html`. For every listed text file (`.html`, `.css`, `.js`, `.md`), run:
```bash
mkdir -p docs/evidence/2026-09-09-feedback-kit/prototype
python3 scripts/od_mcp.py call get_file '{"project":"seo-ops-feedback-kit","path":"index.html"}' > /tmp/od_get_file.json
python3 - <<'EOF'
import json, pathlib
data = json.load(open('/tmp/od_get_file.json'))
content = data.get('content') if isinstance(data, dict) else None
if content is None:
    raise SystemExit('get_file response has no "content" field: ' + str(data)[:300])
pathlib.Path('docs/evidence/2026-09-09-feedback-kit/prototype/index.html').write_text(content, 'utf-8')
print('saved index.html', len(content), 'chars')
EOF
```
Repeat the `get_file` + save pair for each other text file, changing both the `path` argument and the output filename (keep sub-directories). Skip binary files; list their names in `run.json` under a new `"skippedBinaryFiles"` array if any exist.

- [ ] **Step 4: Run the acceptance check**

Run: `python3 docs/evidence/2026-09-09-feedback-kit/check_prototype.py`
Expected: `PASS: N file(s), 5 sections, 12 copy strings, no external resources`

If it prints FAIL: do not edit the prototype by hand. Start one follow-up run on the same project with `start_run` whose prompt is the original `prompt.md` content plus a final line `修正以下问题，其他保持不变：` followed by the FAIL bullet list, using a new `requestId`. Wait with `wait-run`, re-pull the files, rerun the check. Record the second `runId` in `run.json` as `"fixRunId"`. If it still fails, stop and report the remaining bullets to the user.

- [ ] **Step 5: Commit**

```bash
git add docs/evidence/2026-09-09-feedback-kit
git commit -m "docs: archive feedback-kit prototype and acceptance check"
```

- [ ] **Step 6: Hand off for Studio review**

Report to the user, in this order: the `previewUrl` from `run.json`, the OpenDesign project name `seo-ops 反馈模式套件` (so they can find it in the Studio list), the acceptance check result line, and the sentence that phase 2 starts only after they reply 「定稿」. Phase 1 ends here.
