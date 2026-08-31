# 第二块砖：Agent 跑批（core-ai-server 集成）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 商户可手动或按周期自动发起 core-ai agent 分析，run 报告自动解析成带 rationale 的待办任务。

**Architecture:** 在现有 `api/` 上加三个模块：`coreai.py`（httpx 同步客户端）、`runs.py`（runs 表路由 + 发起逻辑）、`scheduler.py`（lifespan 里的 asyncio 后台循环：30 秒轮询进行中 run，每小时扫描自动周期）。解析器 `plan_parser.py` 从报告提取 ```json 块建任务（幂等键去重）。前端在商户详情页加发起按钮/周期下拉/run 历史，新增 run 详情页。

**Tech Stack:** Python 3 / FastAPI / httpx / sqlite3 / pytest；React + Vite + TS（沿用第一块砖）。

**Spec:** `docs/superpowers/specs/2026-08-31-agent-runs-design.md`

## Global Constraints

- core-ai API：`POST /api/runs/agent/{agent_id}/trigger` body `{"input": "<文本>"}` → `{run_id, status}`；`GET /api/runs/{run_id}` → snake_case 详情（`status`、`output`、`error`、`completed_at`）。终态集合：`COMPLETED / FAILED / TIMEOUT / CANCELLED / SKIPPED`，仅 `COMPLETED` 算成功，报告文本取 `output` 字段。
- 配置环境变量：`COREAI_BASE_URL`、`COREAI_API_KEY`、`COREAI_AGENT_ID`；任一缺失 → run 相关接口 503，调度循环直接不启动，台账功能不受影响。真实值放 gitignored 的 `api/.env`（用 `uvicorn --env-file .env` 加载），仓库只提交 `api/.env.example`。
- 本地 runs.status 只有 `running / succeeded / failed`；触发方式列名用 `trigger_kind`（`manual` / `auto`）——TRIGGER 是 SQL 关键字，spec 里写的 `trigger` 落库为 `trigger_kind`。
- 单商户同时最多一个进行中 run，重复发起 409。
- 解析契约：报告中 ```json 块内 `[{id,title,rationale,description?}]`，`id/title/rationale` 必填非空字符串；无合法块时 run 仍 `succeeded` 不建任务；幂等键 `source_key = "plan-{coreai_run_id}-{itemId}"`，冲突跳过。
- 红线：系统自动化止步于创建 `todo` 任务；EXECUTE/VERIFY 永不自动触发。
- 测试永不访问真实 core-ai：客户端测试用 `httpx.MockTransport`，路由/调度测试用假客户端注入；conftest 必须清空 `COREAI_*` 环境变量防止开发者本机变量泄漏进测试。
- 时间戳一律 UTC ISO 8601 字符串；前端不写测试，`npm run build` 通过即可。

---

### Task 1: Schema 迁移 + 配置读取

**Files:**
- Modify: `api/schema.sql`
- Modify: `api/app/db.py`
- Create: `api/app/config.py`、`api/.env.example`
- Modify: `api/tests/conftest.py`
- Test: `api/tests/test_db.py`（追加）、`api/tests/test_config.py`

**Interfaces:**
- Consumes: 现有 `app.db.init_db/connect/db_path`
- Produces: `runs` 表；`merchants.auto_run_interval_days`、`tasks.source_run_id`、`tasks.source_key` 列（新库直接建、老库幂等 ALTER）；部分唯一索引 `idx_tasks_source_key`；`app.config.coreai_settings() -> CoreAiSettings | None`（frozen dataclass：`base_url`（已去尾斜杠）、`api_key`、`agent_id`）

- [ ] **Step 1: conftest 清空 COREAI 环境变量**

修改 `api/tests/conftest.py`，在 `client` fixture 的 `monkeypatch.setenv` 之前加：

```python
    for var in ("COREAI_BASE_URL", "COREAI_API_KEY", "COREAI_AGENT_ID"):
        monkeypatch.delenv(var, raising=False)
```

- [ ] **Step 2: 写失败测试**

在 `api/tests/test_db.py` 追加：

```python
def test_migration_adds_columns_and_runs_table(tmp_path, monkeypatch):
    """老库（第一块砖 schema）跑 init_db 后应获得新列和 runs 表。"""
    monkeypatch.setenv("SEO_OPS_DB", str(tmp_path / "old.db"))
    old_schema = """
    CREATE TABLE merchants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_id INTEGER NOT NULL REFERENCES merchants(id),
      title TEXT NOT NULL,
      description TEXT,
      rationale TEXT,
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','cancelled')),
      evidence_note TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    """
    conn = sqlite3.connect(tmp_path / "old.db")
    conn.executescript(old_schema)
    conn.commit()
    conn.close()

    from app.db import init_db

    init_db()
    init_db()  # 幂等
    conn = sqlite3.connect(tmp_path / "old.db")
    merchant_cols = {r[1] for r in conn.execute("PRAGMA table_info(merchants)")}
    task_cols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)")}
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    indexes = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    conn.close()
    assert "auto_run_interval_days" in merchant_cols
    assert {"source_run_id", "source_key"} <= task_cols
    assert "runs" in tables
    assert "idx_tasks_source_key" in indexes
```

新建 `api/tests/test_config.py`：

```python
def test_coreai_settings_none_when_unset(monkeypatch):
    for var in ("COREAI_BASE_URL", "COREAI_API_KEY", "COREAI_AGENT_ID"):
        monkeypatch.delenv(var, raising=False)
    from app.config import coreai_settings

    assert coreai_settings() is None


def test_coreai_settings_reads_env_and_strips_trailing_slash(monkeypatch):
    monkeypatch.setenv("COREAI_BASE_URL", "https://core.example.com/")
    monkeypatch.setenv("COREAI_API_KEY", "coreai_test")
    monkeypatch.setenv("COREAI_AGENT_ID", "agent-1")
    from app.config import coreai_settings

    s = coreai_settings()
    assert s is not None
    assert s.base_url == "https://core.example.com"
    assert s.api_key == "coreai_test"
    assert s.agent_id == "agent-1"
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd api && .venv/bin/python -m pytest tests/test_db.py tests/test_config.py -v`
Expected: 新迁移测试 FAIL（列/表不存在）；config 测试 FAIL（`ModuleNotFoundError: app.config`）

- [ ] **Step 4: 实现**

`api/schema.sql` 整体替换为（merchants/tasks 的 CREATE 中直接带新列，供全新库；注意 runs 表定义放在 tasks 之前）：

```sql
CREATE TABLE IF NOT EXISTS merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  notes TEXT,
  auto_run_interval_days INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  coreai_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual','auto')),
  report_text TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_merchant ON runs(merchant_id);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  title TEXT NOT NULL,
  description TEXT,
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','cancelled')),
  evidence_note TEXT,
  source_run_id INTEGER REFERENCES runs(id),
  source_key TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_merchant ON tasks(merchant_id);
```

`api/app/db.py` 的 `init_db` 改为（其余函数不动）：

```python
MIGRATION_COLUMNS: dict[str, dict[str, str]] = {
    "merchants": {"auto_run_interval_days": "INTEGER"},
    "tasks": {"source_run_id": "INTEGER REFERENCES runs(id)", "source_key": "TEXT"},
}


def _migrate(conn: sqlite3.Connection) -> None:
    for table, cols in MIGRATION_COLUMNS.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if not existing:
            continue  # 全新库，表还没建，executescript 已带新列
        for col, decl in cols.items():
            if col not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")


def init_db() -> None:
    Path(db_path()).parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        _migrate(conn)
        conn.executescript(SCHEMA_PATH.read_text())
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_key"
            " ON tasks(source_key) WHERE source_key IS NOT NULL"
        )
        conn.commit()
    finally:
        conn.close()
```

（顺序说明：老库先 `_migrate` 补列再 executescript 建 runs 表；全新库 `_migrate` 因 PRAGMA 为空直接跳过，executescript 建全部表。部分唯一索引不写进 schema.sql，因为老库补列前建索引会报"no such column"。）

新建 `api/app/config.py`：

```python
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class CoreAiSettings:
    base_url: str
    api_key: str
    agent_id: str


def coreai_settings() -> CoreAiSettings | None:
    base_url = os.environ.get("COREAI_BASE_URL", "").strip()
    api_key = os.environ.get("COREAI_API_KEY", "").strip()
    agent_id = os.environ.get("COREAI_AGENT_ID", "").strip()
    if not (base_url and api_key and agent_id):
        return None
    return CoreAiSettings(base_url.rstrip("/"), api_key, agent_id)
```

新建 `api/.env.example`：

```
COREAI_BASE_URL=https://core-ai-server.connexup-uat.net
COREAI_API_KEY=coreai_xxx
COREAI_AGENT_ID=
```

- [ ] **Step 5: 跑全部测试确认通过**

Run: `cd api && .venv/bin/python -m pytest tests -v`
Expected: 全部 PASS（含第一块砖 21 个）

- [ ] **Step 6: Commit**

```bash
git add api/schema.sql api/app/db.py api/app/config.py api/.env.example api/tests/conftest.py api/tests/test_db.py api/tests/test_config.py
git commit -m "feat(api): runs schema migration and core-ai settings"
```

---

### Task 2: core-ai HTTP 客户端

**Files:**
- Create: `api/app/coreai.py`
- Test: `api/tests/test_coreai.py`

**Interfaces:**
- Consumes: 无（httpx 已在 requirements.txt）
- Produces: `app.coreai.CoreAiClient(base_url, api_key, timeout=30.0, transport=None)`，方法 `trigger(agent_id: str, input_text: str) -> dict`（保证含 `run_id`）、`get_run(run_id: str) -> dict`（保证含 `status`）、`close()`；异常 `app.coreai.CoreAiError(status_code, message)`；常量 `app.coreai.TERMINAL_STATUSES = {"COMPLETED","FAILED","TIMEOUT","CANCELLED","SKIPPED"}`

- [ ] **Step 1: 写失败测试**

新建 `api/tests/test_coreai.py`：

```python
import httpx
import pytest


def make_client(handler):
    from app.coreai import CoreAiClient

    return CoreAiClient("https://core.test", "coreai_k", transport=httpx.MockTransport(handler))


def test_trigger_posts_input_and_returns_run_id():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("Authorization")
        import json

        seen["body"] = json.loads(request.content)
        return httpx.Response(202, json={"run_id": "r-1", "status": "RUNNING"})

    res = make_client(handler).trigger("agent-9", "hello")
    assert res["run_id"] == "r-1"
    assert seen["url"] == "https://core.test/api/runs/agent/agent-9/trigger"
    assert seen["auth"] == "Bearer coreai_k"
    assert seen["body"] == {"input": "hello"}


def test_trigger_missing_run_id_raises():
    from app.coreai import CoreAiError

    def handler(request):
        return httpx.Response(202, json={"status": "RUNNING"})

    with pytest.raises(CoreAiError):
        make_client(handler).trigger("a", "x")


def test_get_run_returns_detail():
    def handler(request):
        assert str(request.url) == "https://core.test/api/runs/r-2"
        return httpx.Response(200, json={"id": "r-2", "status": "COMPLETED", "output": "report"})

    detail = make_client(handler).get_run("r-2")
    assert detail["status"] == "COMPLETED"
    assert detail["output"] == "report"


def test_http_error_surfaces_status_and_message():
    from app.coreai import CoreAiError

    def handler(request):
        return httpx.Response(401, json={"message": "invalid api key"})

    with pytest.raises(CoreAiError) as e:
        make_client(handler).get_run("r-3")
    assert e.value.status_code == 401
    assert "invalid api key" in str(e.value)


def test_network_error_wrapped():
    from app.coreai import CoreAiError

    def handler(request):
        raise httpx.ConnectError("boom")

    with pytest.raises(CoreAiError):
        make_client(handler).get_run("r-4")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && .venv/bin/python -m pytest tests/test_coreai.py -v`
Expected: FAIL（`ModuleNotFoundError: app.coreai`）

- [ ] **Step 3: 实现**

新建 `api/app/coreai.py`：

```python
import httpx

TERMINAL_STATUSES = {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED"}


class CoreAiError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


class CoreAiClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ):
        # token 只进 Authorization 头，不进 URL/日志/错误消息
        self._client = httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
            transport=transport,
        )

    def _request(self, method: str, path: str, json_body: dict | None = None) -> dict:
        try:
            res = self._client.request(method, path, json=json_body)
        except httpx.HTTPError as e:
            raise CoreAiError(0, f"core-ai request failed: {e}") from e
        if res.status_code >= 400:
            try:
                message = res.json().get("message") or res.text[:200]
            except ValueError:
                message = res.text[:200]
            raise CoreAiError(res.status_code, message)
        try:
            return res.json()
        except ValueError as e:
            raise CoreAiError(0, "core-ai returned non-JSON response") from e

    def trigger(self, agent_id: str, input_text: str) -> dict:
        body = self._request("POST", f"/api/runs/agent/{agent_id}/trigger", {"input": input_text})
        if not body.get("run_id"):
            raise CoreAiError(0, "core-ai trigger response missing run_id")
        return body

    def get_run(self, run_id: str) -> dict:
        body = self._request("GET", f"/api/runs/{run_id}")
        if not body.get("status"):
            raise CoreAiError(0, "core-ai run detail missing status")
        return body

    def close(self) -> None:
        self._client.close()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd api && .venv/bin/python -m pytest tests/test_coreai.py -v`
Expected: 5 个全 PASS

- [ ] **Step 5: Commit**

```bash
git add api/app/coreai.py api/tests/test_coreai.py
git commit -m "feat(api): core-ai http client with mock-transport tests"
```

---

### Task 3: 报告解析器

**Files:**
- Create: `api/app/plan_parser.py`
- Test: `api/tests/test_plan_parser.py`

**Interfaces:**
- Consumes: `app.merchants.now_iso`
- Produces: `app.plan_parser.extract_plan(report_text: str) -> list[dict]`（每项 `{id, title, rationale, description}`，description 可为 None；无合法块返回 `[]`）；`app.plan_parser.create_tasks_from_plan(conn, merchant_id: int, run_id: int, coreai_run_id: str, items: list[dict]) -> int`（返回实际创建数，`source_key` 冲突跳过）

- [ ] **Step 1: 写失败测试**

新建 `api/tests/test_plan_parser.py`（注意：下面用四反引号围栏，因为测试字符串里含三反引号）：

````python
VALID_REPORT = """# 分析报告

一些前文。

```json
[
  {"id": "item-1", "title": "修复 GBP 营业时间", "rationale": "营业时间与官网不一致", "description": "改成 9-18"},
  {"id": "item-2", "title": "补充商户照片", "rationale": "照片数量低于同行"}
]
```

一些后文。
"""


def test_extract_plan_parses_valid_block():
    from app.plan_parser import extract_plan

    items = extract_plan(VALID_REPORT)
    assert len(items) == 2
    assert items[0] == {
        "id": "item-1",
        "title": "修复 GBP 营业时间",
        "rationale": "营业时间与官网不一致",
        "description": "改成 9-18",
    }
    assert items[1]["description"] is None


def test_extract_plan_skips_invalid_entries():
    from app.plan_parser import extract_plan

    report = '```json\n[{"id": "a", "title": "t", "rationale": "r"}, {"id": "b", "title": ""}, "junk"]\n```'
    items = extract_plan(report)
    assert [i["id"] for i in items] == ["a"]


def test_extract_plan_no_block_or_bad_json_returns_empty():
    from app.plan_parser import extract_plan

    assert extract_plan("没有代码块的普通报告") == []
    assert extract_plan("```json\n{not json}\n```") == []
    assert extract_plan("") == []
    assert extract_plan(None) == []


def test_create_tasks_idempotent(client):
    """通过 client fixture 拿到已初始化的库；直接用底层连接验证幂等。"""
    from app.db import connect
    from app.plan_parser import create_tasks_from_plan, extract_plan

    m = client.post("/api/merchants", json={"name": "M"}).json()
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at)"
            " VALUES (?, 'core-r1', 'running', 'manual', '2026-08-31T00:00:00+00:00')",
            (m["id"],),
        )
        run_id = conn.execute("SELECT id FROM runs").fetchone()["id"]
        items = extract_plan(VALID_REPORT)
        assert create_tasks_from_plan(conn, m["id"], run_id, "core-r1", items) == 2
        assert create_tasks_from_plan(conn, m["id"], run_id, "core-r1", items) == 0  # 幂等
        conn.commit()
    finally:
        conn.close()

    tasks = client.get(f"/api/merchants/{m['id']}/tasks").json()
    assert len(tasks) == 2
    by_key = {t["source_key"]: t for t in tasks}
    assert set(by_key) == {"plan-core-r1-item-1", "plan-core-r1-item-2"}
    t1 = by_key["plan-core-r1-item-1"]
    assert t1["status"] == "todo"
    assert t1["rationale"] == "营业时间与官网不一致"
    assert t1["source_run_id"] == run_id
````

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && .venv/bin/python -m pytest tests/test_plan_parser.py -v`
Expected: FAIL（`ModuleNotFoundError: app.plan_parser`）

- [ ] **Step 3: 实现**

新建 `api/app/plan_parser.py`：

```python
import json
import re
import sqlite3

from .merchants import now_iso

JSON_BLOCK_RE = re.compile(r"```json\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def extract_plan(report_text: str | None) -> list[dict]:
    for block in JSON_BLOCK_RE.findall(report_text or ""):
        try:
            data = json.loads(block)
        except ValueError:
            continue
        if not isinstance(data, list):
            continue
        items = []
        for entry in data:
            if not isinstance(entry, dict):
                continue
            item_id = entry.get("id")
            title = entry.get("title")
            rationale = entry.get("rationale")
            if not (
                isinstance(item_id, str) and item_id
                and isinstance(title, str) and title
                and isinstance(rationale, str) and rationale
            ):
                continue
            description = entry.get("description")
            items.append({
                "id": item_id,
                "title": title,
                "rationale": rationale,
                "description": description if isinstance(description, str) and description else None,
            })
        if items:
            return items
    return []


def create_tasks_from_plan(
    conn: sqlite3.Connection,
    merchant_id: int,
    run_id: int,
    coreai_run_id: str,
    items: list[dict],
) -> int:
    created = 0
    for item in items:
        source_key = f"plan-{coreai_run_id}-{item['id']}"
        cur = conn.execute(
            "INSERT OR IGNORE INTO tasks"
            " (merchant_id, title, description, rationale, source_run_id, source_key, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (merchant_id, item["title"], item["description"], item["rationale"], run_id, source_key, now_iso()),
        )
        created += cur.rowcount
    return created
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd api && .venv/bin/python -m pytest tests/test_plan_parser.py -v`
Expected: 4 个全 PASS

- [ ] **Step 5: Commit**

```bash
git add api/app/plan_parser.py api/tests/test_plan_parser.py
git commit -m "feat(api): plan parser with idempotent task creation"
```

---

### Task 4: runs 路由 + 商户周期字段

**Files:**
- Create: `api/app/runs.py`、`api/tests/helpers.py`
- Modify: `api/app/merchants.py`（MerchantPatch 加 `auto_run_interval_days`）
- Modify: `api/app/main.py`（挂 runs router）
- Test: `api/tests/test_runs_api.py`

**Interfaces:**
- Consumes: `app.coreai.CoreAiClient/CoreAiError`、`app.config.coreai_settings`、`app.merchants.fetch_merchant/now_iso`、`app.db.get_db`
- Produces: 路由 `POST /api/merchants/{id}/runs`（201；409 进行中冲突；503 未配置；404 商户不存在；trigger 失败时也 201 但 run.status=failed）、`GET /api/merchants/{id}/runs`（列表，不含 report_text）、`GET /api/runs/{id}`（详情含 report_text）；供调度器复用的 `app.runs.start_run(conn, client, agent_id, merchant_row, trigger_kind) -> sqlite3.Row`、`app.runs.has_running_run(conn, merchant_id) -> bool`、`app.runs.build_input(merchant_row) -> str`；FastAPI 依赖 `app.runs.get_coreai()`（测试用 `app.dependency_overrides[get_coreai] = lambda: (fake, "agent-id")` 覆盖）；`PATCH /api/merchants/{id}` 接受 `auto_run_interval_days`（≥1 的整数或 null，null=关闭）

- [ ] **Step 1: 写失败测试**

新建共享测试辅助 `api/tests/helpers.py`（pytest 的 prepend import 模式会把 tests/ 目录放进 sys.path，测试文件可直接 `from helpers import ...`）：

```python
class FakeCoreAi:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.triggered: list[tuple[str, str]] = []
        self.runs: dict[str, dict] = {}

    def trigger(self, agent_id: str, input_text: str) -> dict:
        from app.coreai import CoreAiError

        if self.fail:
            raise CoreAiError(500, "core-ai down")
        rid = f"core-{len(self.triggered) + 1}"
        self.triggered.append((agent_id, input_text))
        self.runs[rid] = {"id": rid, "status": "RUNNING"}
        return {"run_id": rid, "status": "RUNNING"}

    def get_run(self, run_id: str) -> dict:
        return self.runs[run_id]


def override_coreai(fake, agent_id="agent-t"):
    from app.main import app
    from app.runs import get_coreai

    app.dependency_overrides[get_coreai] = lambda: (fake, agent_id)
    return app


def cleanup_override():
    from app.main import app

    app.dependency_overrides.clear()
```

新建 `api/tests/test_runs_api.py`：

```python
from helpers import FakeCoreAi, cleanup_override, override_coreai


def test_create_run_triggers_and_stores(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        m = client.post("/api/merchants", json={"name": "Alpha", "notes": "n"}).json()
        res = client.post(f"/api/merchants/{m['id']}/runs")
        assert res.status_code == 201
        run = res.json()
        assert run["status"] == "running"
        assert run["trigger_kind"] == "manual"
        assert run["coreai_run_id"] == "core-1"
        agent_id, input_text = fake.triggered[0]
        assert agent_id == "agent-t"
        assert "Alpha" in input_text
    finally:
        cleanup_override()


def test_create_run_conflict_when_running(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        m = client.post("/api/merchants", json={"name": "M"}).json()
        assert client.post(f"/api/merchants/{m['id']}/runs").status_code == 201
        assert client.post(f"/api/merchants/{m['id']}/runs").status_code == 409
    finally:
        cleanup_override()


def test_create_run_503_when_unconfigured(client):
    m = client.post("/api/merchants", json={"name": "M"}).json()
    assert client.post(f"/api/merchants/{m['id']}/runs").status_code == 503


def test_create_run_404_missing_merchant(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        assert client.post("/api/merchants/999/runs").status_code == 404
    finally:
        cleanup_override()


def test_trigger_failure_stores_failed_run(client):
    override_coreai(FakeCoreAi(fail=True))
    try:
        m = client.post("/api/merchants", json={"name": "M"}).json()
        res = client.post(f"/api/merchants/{m['id']}/runs")
        assert res.status_code == 201
        run = res.json()
        assert run["status"] == "failed"
        assert "core-ai down" in run["error"]
        assert run["finished_at"] is not None
        # 失败 run 不算进行中，可再次发起
        assert client.post(f"/api/merchants/{m['id']}/runs").status_code == 201
    finally:
        cleanup_override()


def test_list_and_get_runs(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        m = client.post("/api/merchants", json={"name": "M"}).json()
        run = client.post(f"/api/merchants/{m['id']}/runs").json()
        listed = client.get(f"/api/merchants/{m['id']}/runs").json()
        assert [r["id"] for r in listed] == [run["id"]]
        assert "report_text" not in listed[0]
        detail = client.get(f"/api/runs/{run['id']}").json()
        assert detail["id"] == run["id"]
        assert "report_text" in detail
        assert client.get("/api/runs/999").status_code == 404
        assert client.get("/api/merchants/999/runs").status_code == 404
    finally:
        cleanup_override()


def test_patch_merchant_interval(client):
    m = client.post("/api/merchants", json={"name": "M"}).json()
    assert m["auto_run_interval_days"] is None
    res = client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": 7})
    assert res.json()["auto_run_interval_days"] == 7
    res = client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": None})
    assert res.json()["auto_run_interval_days"] is None
    assert client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": 0}).status_code == 422
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && .venv/bin/python -m pytest tests/test_runs_api.py -v`
Expected: FAIL（路由 404 / import 错误）

- [ ] **Step 3: 实现**

新建 `api/app/runs.py`：

```python
import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from .config import coreai_settings
from .coreai import CoreAiClient, CoreAiError
from .db import get_db
from .merchants import fetch_merchant, now_iso

router = APIRouter(prefix="/api", tags=["runs"])

RUN_LIST_COLUMNS = "id, merchant_id, coreai_run_id, status, trigger_kind, error, created_at, finished_at"

_client: CoreAiClient | None = None


def get_coreai() -> tuple[CoreAiClient, str]:
    global _client
    settings = coreai_settings()
    if settings is None:
        raise HTTPException(status_code=503, detail="core-ai not configured")
    if _client is None:
        _client = CoreAiClient(settings.base_url, settings.api_key)
    return _client, settings.agent_id


def build_input(merchant: sqlite3.Row) -> str:
    return f"商户：{merchant['name']}\n备注：{merchant['notes'] or '无'}"


def has_running_run(conn: sqlite3.Connection, merchant_id: int) -> bool:
    row = conn.execute(
        "SELECT 1 FROM runs WHERE merchant_id = ? AND status = 'running' LIMIT 1",
        (merchant_id,),
    ).fetchone()
    return row is not None


def start_run(
    conn: sqlite3.Connection,
    client: CoreAiClient,
    agent_id: str,
    merchant: sqlite3.Row,
    trigger_kind: str,
) -> sqlite3.Row:
    try:
        res = client.trigger(agent_id, build_input(merchant))
        cur = conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at)"
            " VALUES (?, ?, 'running', ?, ?)",
            (merchant["id"], res["run_id"], trigger_kind, now_iso()),
        )
    except CoreAiError as e:
        now = now_iso()
        cur = conn.execute(
            "INSERT INTO runs (merchant_id, status, trigger_kind, error, created_at, finished_at)"
            " VALUES (?, 'failed', ?, ?, ?, ?)",
            (merchant["id"], trigger_kind, str(e), now, now),
        )
    conn.commit()
    return conn.execute("SELECT * FROM runs WHERE id = ?", (cur.lastrowid,)).fetchone()


@router.post("/merchants/{merchant_id}/runs", status_code=201)
def create_run(merchant_id: int, coreai=Depends(get_coreai), conn=Depends(get_db)):
    merchant = fetch_merchant(conn, merchant_id)
    if has_running_run(conn, merchant_id):
        raise HTTPException(status_code=409, detail="a run is already in progress for this merchant")
    client, agent_id = coreai
    return dict(start_run(conn, client, agent_id, merchant, "manual"))


@router.get("/merchants/{merchant_id}/runs")
def list_runs(merchant_id: int, conn=Depends(get_db)):
    fetch_merchant(conn, merchant_id)
    rows = conn.execute(
        f"SELECT {RUN_LIST_COLUMNS} FROM runs WHERE merchant_id = ? ORDER BY id DESC",
        (merchant_id,),
    ).fetchall()
    return [dict(r) for r in rows]


@router.get("/runs/{run_id}")
def get_run(run_id: int, conn=Depends(get_db)):
    row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")
    return dict(row)
```

`api/app/merchants.py` 的 `MerchantPatch` 加一个字段（其余不动；注意 `auto_run_interval_days` 允许显式 null=关闭，不进 non-nullable 守卫列表）：

```python
class MerchantPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    status: Literal["active", "archived"] | None = None
    notes: str | None = None
    auto_run_interval_days: int | None = Field(default=None, ge=1)
```

`api/app/main.py` 加挂 runs router（在 tasks router 之后）：

```python
from .runs import router as runs_router
...
app.include_router(runs_router)
```

- [ ] **Step 4: 跑全部测试确认通过**

Run: `cd api && .venv/bin/python -m pytest tests -v`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add api/app/runs.py api/app/merchants.py api/app/main.py api/tests/helpers.py api/tests/test_runs_api.py
git commit -m "feat(api): run endpoints with in-flight guard and merchant auto-run interval"
```

---

### Task 5: 调度器（轮询 + 自动扫描 + lifespan）

**Files:**
- Create: `api/app/scheduler.py`
- Modify: `api/app/main.py`（lifespan 启动循环）
- Test: `api/tests/test_scheduler.py`

**Interfaces:**
- Consumes: `app.coreai.TERMINAL_STATUSES/CoreAiError`、`app.runs.start_run/has_running_run`、`app.plan_parser.extract_plan/create_tasks_from_plan`、`app.db.connect`、`app.config.coreai_settings`
- Produces: `app.scheduler.poll_runs_once(client) -> None`（轮询所有 running run 并落终态+解析建任务）、`app.scheduler.auto_scan_once(client, agent_id) -> None`（到期商户自动发起）、`app.scheduler.scheduler_loop()`（async；未配置直接 return；30 秒一轮轮询，每 120 轮=1 小时扫一次）

- [ ] **Step 1: 写失败测试**

新建 `api/tests/test_scheduler.py`（四反引号围栏，字符串里含三反引号）：

````python
from datetime import datetime, timedelta, timezone

from helpers import FakeCoreAi, cleanup_override, override_coreai

REPORT_WITH_PLAN = '报告\n```json\n[{"id": "i1", "title": "T1", "rationale": "R1"}]\n```\n'


def iso_days_ago(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def make_merchant_with_run(client, fake, name="M"):
    m = client.post("/api/merchants", json={"name": name}).json()
    override_coreai(fake)
    try:
        run = client.post(f"/api/merchants/{m['id']}/runs").json()
    finally:
        cleanup_override()
    return m, run


def test_poll_marks_succeeded_and_creates_tasks(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {"status": "COMPLETED", "output": REPORT_WITH_PLAN}

    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "succeeded"
    assert detail["report_text"] == REPORT_WITH_PLAN
    assert detail["finished_at"] is not None
    tasks = client.get(f"/api/merchants/{m['id']}/tasks").json()
    assert [t["title"] for t in tasks] == ["T1"]
    assert tasks[0]["source_run_id"] == run["id"]

    poll_runs_once(fake)  # 再跑一轮：终态 run 不再轮询，任务不重复
    assert len(client.get(f"/api/merchants/{m['id']}/tasks").json()) == 1


def test_poll_completed_without_plan_block_still_succeeds(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {"status": "COMPLETED", "output": "纯文本报告，没有 JSON 块"}

    poll_runs_once(fake)

    assert client.get(f"/api/runs/{run['id']}").json()["status"] == "succeeded"
    assert client.get(f"/api/merchants/{m['id']}/tasks").json() == []


def test_poll_marks_failed_on_terminal_failure(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {"status": "TIMEOUT", "error": "took too long"}

    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "failed"
    assert "took too long" in detail["error"]


def test_poll_leaves_nonterminal_running(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {"status": "RUNNING"}

    poll_runs_once(fake)

    assert client.get(f"/api/runs/{run['id']}").json()["status"] == "running"


def test_auto_scan_triggers_due_merchants_only(client):
    from app.db import connect
    from app.scheduler import auto_scan_once

    fake = FakeCoreAi()
    due = client.post("/api/merchants", json={"name": "due"}).json()
    client.patch(f"/api/merchants/{due['id']}", json={"auto_run_interval_days": 7})
    fresh = client.post("/api/merchants", json={"name": "fresh"}).json()
    client.patch(f"/api/merchants/{fresh['id']}", json={"auto_run_interval_days": 7})
    off = client.post("/api/merchants", json={"name": "off"}).json()
    archived = client.post("/api/merchants", json={"name": "arch"}).json()
    client.patch(f"/api/merchants/{archived['id']}", json={"auto_run_interval_days": 1})
    client.patch(f"/api/merchants/{archived['id']}", json={"status": "archived"})

    conn = connect()
    try:
        # due：上次 run 8 天前结束；fresh：昨天结束
        conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
            " VALUES (?, 'old-1', 'succeeded', 'manual', ?, ?)",
            (due["id"], iso_days_ago(8.1), iso_days_ago(8)),
        )
        conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
            " VALUES (?, 'old-2', 'succeeded', 'manual', ?, ?)",
            (fresh["id"], iso_days_ago(1.1), iso_days_ago(1)),
        )
        conn.commit()
    finally:
        conn.close()

    auto_scan_once(fake, "agent-t")

    assert len(fake.triggered) == 1  # 只有 due
    runs = client.get(f"/api/merchants/{due['id']}/runs").json()
    assert runs[0]["trigger_kind"] == "auto"
    assert runs[0]["status"] == "running"
    assert client.get(f"/api/merchants/{fresh['id']}/runs").json()[0]["coreai_run_id"] == "old-2"
    assert client.get(f"/api/merchants/{off['id']}/runs").json() == []


def test_auto_scan_first_run_when_never_ran(client):
    from app.scheduler import auto_scan_once

    fake = FakeCoreAi()
    m = client.post("/api/merchants", json={"name": "never"}).json()
    client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": 30})

    auto_scan_once(fake, "agent-t")

    assert len(fake.triggered) == 1


def test_auto_scan_skips_merchant_with_running_run(client):
    from app.scheduler import auto_scan_once

    fake = FakeCoreAi()
    m, _run = make_merchant_with_run(client, fake)
    client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": 1})
    before = len(fake.triggered)

    auto_scan_once(fake, "agent-t")

    assert len(fake.triggered) == before
````

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && .venv/bin/python -m pytest tests/test_scheduler.py -v`
Expected: FAIL（`ModuleNotFoundError: app.scheduler`）

- [ ] **Step 3: 实现**

新建 `api/app/scheduler.py`：

```python
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from .config import coreai_settings
from .coreai import CoreAiClient, CoreAiError, TERMINAL_STATUSES
from .db import connect
from .merchants import now_iso
from .plan_parser import create_tasks_from_plan, extract_plan
from .runs import has_running_run, start_run

logger = logging.getLogger("seo_ops.scheduler")

POLL_INTERVAL_SECONDS = 30
SCAN_EVERY_TICKS = 120  # 120 * 30s = 1 小时


def poll_runs_once(client) -> None:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM runs WHERE status = 'running' AND coreai_run_id IS NOT NULL"
        ).fetchall()
        for run in rows:
            try:
                core = client.get_run(run["coreai_run_id"])
            except CoreAiError as e:
                logger.warning("poll run %s failed, stays running: %s", run["id"], e)
                continue
            status = core["status"]
            if status not in TERMINAL_STATUSES:
                continue
            finished_at = core.get("completed_at") or now_iso()
            if status == "COMPLETED":
                report = core.get("output") or None
                conn.execute(
                    "UPDATE runs SET status = 'succeeded', report_text = ?, finished_at = ? WHERE id = ?",
                    (report, finished_at, run["id"]),
                )
                items = extract_plan(report)
                if items:
                    create_tasks_from_plan(conn, run["merchant_id"], run["id"], run["coreai_run_id"], items)
            else:
                conn.execute(
                    "UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
                    (core.get("error") or f"core-ai status {status}", finished_at, run["id"]),
                )
            conn.commit()
    finally:
        conn.close()


def auto_scan_once(client, agent_id: str) -> None:
    conn = connect()
    try:
        merchants = conn.execute(
            "SELECT * FROM merchants WHERE status = 'active' AND auto_run_interval_days IS NOT NULL"
        ).fetchall()
        now = datetime.now(timezone.utc)
        for merchant in merchants:
            if has_running_run(conn, merchant["id"]):
                continue
            last = conn.execute(
                "SELECT finished_at, created_at FROM runs WHERE merchant_id = ? ORDER BY id DESC LIMIT 1",
                (merchant["id"],),
            ).fetchone()
            if last is not None:
                anchor = datetime.fromisoformat(last["finished_at"] or last["created_at"])
                if now - anchor < timedelta(days=merchant["auto_run_interval_days"]):
                    continue
            start_run(conn, client, agent_id, merchant, "auto")
    finally:
        conn.close()


async def scheduler_loop() -> None:
    settings = coreai_settings()
    if settings is None:
        logger.info("core-ai not configured; scheduler disabled")
        return
    client = CoreAiClient(settings.base_url, settings.api_key)
    tick = 0
    while True:
        try:
            await asyncio.to_thread(poll_runs_once, client)
            if tick % SCAN_EVERY_TICKS == 0:
                await asyncio.to_thread(auto_scan_once, client, settings.agent_id)
        except Exception:
            logger.exception("scheduler tick failed")
        tick += 1
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
```

`api/app/main.py` 整体替换为：

```python
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .db import init_db
from .merchants import router as merchants_router
from .runs import router as runs_router
from .scheduler import scheduler_loop
from .tasks import router as tasks_router

init_db()


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(scheduler_loop())
    yield
    task.cancel()


app = FastAPI(title="SEO Ops API", lifespan=lifespan)
app.include_router(merchants_router)
app.include_router(tasks_router)
app.include_router(runs_router)
```

（conftest 已清空 `COREAI_*`，TestClient 触发 lifespan 时 `scheduler_loop` 因未配置立即 return，不会有后台活动。）

- [ ] **Step 4: 跑全部测试确认通过**

Run: `cd api && .venv/bin/python -m pytest tests -v`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add api/app/scheduler.py api/app/main.py api/tests/test_scheduler.py
git commit -m "feat(api): run poller and auto-run scheduler on app lifespan"
```

---

### Task 6: 前端 api.ts 扩展 + 商户详情页（发起/周期/历史/AI 标记）

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/pages/MerchantDetail.tsx`（整体替换，最终内容见下）

**Interfaces:**
- Consumes: Task 4 的 REST 接口
- Produces: `api.listRuns(merchantId) -> Run[]`、`api.createRun(merchantId) -> Run`、`api.getRun(id) -> Run`；类型 `Run`、`RunStatus`；`Merchant` 加 `auto_run_interval_days: number | null`；`Task` 加 `source_run_id: number | null` 和 `source_key: string | null`（Task 7 的 RunDetail 页复用 `api.getRun`）

- [ ] **Step 1: 扩展 api.ts**

`web/src/api.ts`：`Merchant` 类型加一行 `auto_run_interval_days: number | null`；`Task` 类型加两行 `source_run_id: number | null` 和 `source_key: string | null`；`patchMerchant` 的 body 类型改为 `Partial<Pick<Merchant, 'name' | 'status' | 'notes' | 'auto_run_interval_days'>>`；文件末尾 `api` 对象前加：

```ts
export type RunStatus = 'running' | 'succeeded' | 'failed'

export type Run = {
  id: number
  merchant_id: number
  coreai_run_id: string | null
  status: RunStatus
  trigger_kind: 'manual' | 'auto'
  report_text?: string | null
  error: string | null
  created_at: string
  finished_at: string | null
}
```

`api` 对象内加三个方法：

```ts
  listRuns: (merchantId: number) => request<Run[]>(`/api/merchants/${merchantId}/runs`),
  createRun: (merchantId: number) => request<Run>(`/api/merchants/${merchantId}/runs`, { method: 'POST' }),
  getRun: (id: number) => request<Run>(`/api/runs/${id}`),
```

- [ ] **Step 2: 重写 MerchantDetail.tsx**

`web/src/pages/MerchantDetail.tsx` 整体替换为：

```tsx
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type Merchant, type Run, type Task, type TaskStatus } from '../api'

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  cancelled: '已取消',
}
const STATUS_ORDER: TaskStatus[] = ['todo', 'doing', 'done', 'cancelled']
const RUN_LABELS: Record<Run['status'], string> = { running: '进行中', succeeded: '成功', failed: '失败' }
const INTERVAL_OPTIONS = [
  { value: '', label: '自动分析：关闭' },
  { value: '7', label: '自动分析：每 7 天' },
  { value: '30', label: '自动分析：每 30 天' },
]

export default function MerchantDetail() {
  const { id } = useParams()
  const merchantId = Number(id)
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [title, setTitle] = useState('')
  const [rationale, setRationale] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.getMerchant(merchantId)
      .then(m => { setMerchant(m); setError('') })
      .catch(e => setError((e as Error).message))
    api.listTasks(merchantId).then(setTasks).catch(e => setError((e as Error).message))
    api.listRuns(merchantId).then(setRuns).catch(e => setError((e as Error).message))
  }, [merchantId])

  useEffect(load, [load])

  const hasRunning = runs.some(r => r.status === 'running')

  useEffect(() => {
    if (!hasRunning) return
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [hasRunning, load])

  const createTask = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    try {
      await api.createTask(merchantId, {
        title: title.trim(),
        rationale: rationale.trim() || undefined,
        description: description.trim() || undefined,
      })
      setTitle('')
      setRationale('')
      setDescription('')
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const toggleArchive = async () => {
    if (!merchant) return
    try {
      setMerchant(await api.patchMerchant(merchant.id, { status: merchant.status === 'active' ? 'archived' : 'active' }))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const startRun = async () => {
    try {
      await api.createRun(merchantId)
      setError('')
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const changeInterval = async (value: string) => {
    try {
      setMerchant(await api.patchMerchant(merchantId, { auto_run_interval_days: value === '' ? null : Number(value) }))
      setError('')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (!merchant) {
    return (
      <main>
        <p><Link to="/">← 商户列表</Link></p>
        {error ? <p className="error">{error}</p> : <p>加载中…</p>}
      </main>
    )
  }

  return (
    <main>
      <p><Link to="/">← 商户列表</Link></p>
      <h1>{merchant.name}</h1>
      <p>
        <span className={`badge ${merchant.status}`}>{merchant.status === 'active' ? '在营' : '已归档'}</span>
        <button onClick={toggleArchive}>{merchant.status === 'active' ? '归档' : '恢复在营'}</button>
      </p>
      {merchant.notes && <p className="muted">{merchant.notes}</p>}
      {error && <p className="error">{error}</p>}

      <h2>AI 分析</h2>
      <p>
        <button onClick={startRun} disabled={hasRunning}>
          {hasRunning ? '分析进行中…' : '发起分析'}
        </button>
        {' '}
        <select
          value={merchant.auto_run_interval_days == null ? '' : String(merchant.auto_run_interval_days)}
          onChange={e => changeInterval(e.target.value)}
        >
          {INTERVAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </p>
      {runs.length > 0 && (
        <ul className="list">
          {runs.map(r => (
            <li key={r.id}>
              <Link to={`/runs/${r.id}`}>#{r.id}</Link>
              <span className={`badge ${r.status}`}>{RUN_LABELS[r.status]}</span>
              <span className="muted">{r.trigger_kind === 'auto' ? '自动' : '手动'} · {r.created_at}</span>
              {r.error && <span className="muted">{r.error}</span>}
            </li>
          ))}
        </ul>
      )}

      <h2>新建任务</h2>
      <form onSubmit={createTask}>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="标题" />
        <input value={rationale} onChange={e => setRationale(e.target.value)} placeholder="为什么做（动因）" />
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="描述（可选）" />
        <button type="submit">创建</button>
      </form>

      {STATUS_ORDER.map(s => {
        const group = tasks.filter(t => t.status === s)
        if (group.length === 0) return null
        return (
          <section key={s}>
            <h2>{STATUS_LABELS[s]}（{group.length}）</h2>
            <ul className="list">
              {group.map(t => (
                <li key={t.id}>
                  <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                  {t.source_run_id != null && <span className="badge">AI</span>}
                  {t.rationale && <span className="muted">{t.rationale}</span>}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </main>
  )
}
```

- [ ] **Step 3: 构建验证**

Run: `cd web && npm run build`
Expected: 构建成功，无 TS 错误

- [ ] **Step 4: Commit**

```bash
git add web/src/api.ts web/src/pages/MerchantDetail.tsx
git commit -m "feat(web): run trigger, auto-run interval, run history and AI badge on merchant page"
```

---

### Task 7: Run 详情页 + 路由

**Files:**
- Create: `web/src/pages/RunDetail.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `api.getRun`、类型 `Run`
- Produces: 页面 `/runs/:id`：状态、触发方式、时间、错误、`<pre>` 报告全文

- [ ] **Step 1: 实现页面**

新建 `web/src/pages/RunDetail.tsx`：

```tsx
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type Run } from '../api'

const LABELS: Record<Run['status'], string> = { running: '进行中', succeeded: '成功', failed: '失败' }

export default function RunDetail() {
  const { id } = useParams()
  const runId = Number(id)
  const [run, setRun] = useState<Run | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getRun(runId).then(setRun).catch(e => setError((e as Error).message))
  }, [runId])

  if (!run) {
    return (
      <main>
        <p><Link to="/">← 商户列表</Link></p>
        {error ? <p className="error">{error}</p> : <p>加载中…</p>}
      </main>
    )
  }

  return (
    <main>
      <p><Link to={`/merchants/${run.merchant_id}`}>← 返回商户</Link></p>
      <h1>分析 #{run.id}</h1>
      <p>
        <span className={`badge ${run.status}`}>{LABELS[run.status]}</span>
        <span className="muted">{run.trigger_kind === 'auto' ? '自动' : '手动'} · 发起于 {run.created_at}{run.finished_at ? ` · 结束于 ${run.finished_at}` : ''}</span>
      </p>
      {error && <p className="error">{error}</p>}
      {run.error && <p className="error">{run.error}</p>}

      <h2>报告</h2>
      {run.report_text
        ? <pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto' }}>{run.report_text}</pre>
        : <p className="muted">（暂无报告）</p>}
    </main>
  )
}
```

修改 `web/src/App.tsx` 整体替换为：

```tsx
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import MerchantList from './pages/MerchantList'
import MerchantDetail from './pages/MerchantDetail'
import TaskDetail from './pages/TaskDetail'
import RunDetail from './pages/RunDetail'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MerchantList />} />
        <Route path="/merchants/:id" element={<MerchantDetail />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/runs/:id" element={<RunDetail />} />
      </Routes>
    </BrowserRouter>
  )
}
```

- [ ] **Step 2: 构建验证**

Run: `cd web && npm run build`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/RunDetail.tsx web/src/App.tsx
git commit -m "feat(web): run detail page with report view"
```

---

### Task 8: README 更新 + 无配置冒烟

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 全部
- Produces: 文档 + 无 core-ai 配置下系统可用的验证记录

- [ ] **Step 1: 无配置冒烟**

```bash
cd /Users/xander/git_repo/connexup-seo-ops/api
env -u COREAI_BASE_URL -u COREAI_API_KEY -u COREAI_AGENT_ID .venv/bin/uvicorn app.main:app --port 8000 &
sleep 2
curl -s localhost:8000/api/merchants | head -c 200; echo
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:8000/api/merchants/1/runs
```

Expected: 商户列表正常返回；POST runs 返回 503（未配置 core-ai，台账不受影响）。验证后停掉后台进程。

- [ ] **Step 2: 更新 README**

`README.md` 的 `## 开发运行` 一节，把后端启动命令替换为：

```
    cd api
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    cp .env.example .env   # 填入 core-ai 配置；不配置则 AI 分析功能返回 503，台账不受影响
    .venv/bin/uvicorn app.main:app --reload --port 8000 --env-file .env
```

并在 `## 结构` 之后追加一节（四反引号围栏，内容里含三反引号字样）：

````
## AI 分析（第二块砖）

- 商户详情页可手动"发起分析"，或设置每商户自动周期（7/30 天）
- 后台每 30 秒轮询进行中的 run，每小时扫描到期商户
- 报告中的 ```json 计划块自动解析为待办任务（幂等，不重复创建）；无计划块时报告仍可在 run 详情页查看
- agent 通过 COREAI_AGENT_ID 配置；执行/验证永不自动触发，任务状态永远人工流转
- 设计文档：docs/superpowers/specs/2026-08-31-agent-runs-design.md
````

- [ ] **Step 3: 全量回归**

Run: `cd api && .venv/bin/python -m pytest tests -v && cd ../web && npm run build`
Expected: 后端全部 PASS，前端构建成功

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: brick 2 usage and env setup in README"
```

---

## 计划外（不在本计划内，完成后待办）

- 拿真实 agent 验证解析契约：需要用户先定 `COREAI_AGENT_ID`，把真实 token 写入 `api/.env`（可从 `_to_delete/v2-leftovers/server/.env` 或 Mongo `core-ai.users.api_key` 获取），发起一次真实 run 检查 ```json 块格式；对不上时在 core-ai 平台上调 agent 输出约定，不改本仓库代码。
