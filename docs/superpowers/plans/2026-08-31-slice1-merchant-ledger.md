# 第一块砖：商户台账 + 任务工单 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成可立即投入使用的最小运营台账：商户列表 → 商户任务 → 人工执行与证据回填。

**Architecture:** 前后端分离。后端 `api/` 为 FastAPI + SQLite（单 SQL 文件管 schema，无 ORM），前端 `web/` 为 React + Vite + TS，开发期通过 Vite proxy 把 `/api` 转发到 8000 端口（因此后端不需要 CORS）。只有 merchants、tasks 两张表。

**Tech Stack:** Python 3 / FastAPI / sqlite3（标准库）/ pytest；React 18 / Vite / TypeScript / react-router-dom。

**Spec:** `docs/superpowers/specs/2026-08-31-seo-ops-rebuild-slice1-design.md`

## Global Constraints

- 数据库文件：默认 `data/seo-ops-v3.db`，可用环境变量 `SEO_OPS_DB` 覆盖（测试用）。
- 商户状态只有 `active` / `archived`；任务状态只有 `todo` / `doing` / `done` / `cancelled`。
- 任务状态流转仅允许：`todo→doing`、`doing→done`、`todo→cancelled`、`doing→cancelled`；其余一律 422。进入 `done` 时写 `completed_at`。
- 删除商户仅允许无任务的商户，否则 409。
- 第一版无登录、无附件上传、无 AI；不迁移旧数据（`data/seo-ops.db` 归档不动）。
- 时间戳一律 UTC ISO 8601 字符串。
- 前端不写测试，`npm run build` 通过即可；后端 pytest 覆盖全部接口与错误路径。

---

### Task 1: 仓库清理与 .gitignore

**Files:**
- Move: `dist/`、`server/`、`node_modules/`、`tsconfig.app.tsbuildinfo`、`tsconfig.node.tsbuildinfo` → `_to_delete/`
- Create: `.gitignore`

**Interfaces:**
- Consumes: 无
- Produces: 干净的仓库根目录；后续任务在 `api/`、`web/` 下新建代码

- [ ] **Step 1: 把 v2 残留挪进 _to_delete/**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
mkdir -p _to_delete/v2-leftovers
mv dist server node_modules tsconfig.app.tsbuildinfo tsconfig.node.tsbuildinfo _to_delete/v2-leftovers/
```

注意：`data/` 原地不动（旧库归档在里面）；`docs/evidence/` 不动。

- [ ] **Step 2: 创建 .gitignore**

写入 `.gitignore`：

```gitignore
node_modules/
dist/
.venv/
__pycache__/
*.pyc
*.tsbuildinfo
data/
_to_delete/
.idea/
.DS_Store
```

- [ ] **Step 3: 验证 git status 干净**

Run: `git status --short`
Expected: 只剩 `.gitignore` 和 `docs/` 相关未跟踪项，不再出现 dist/server/node_modules。

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: clean v2 leftovers, add .gitignore"
```

---

### Task 2: 后端脚手架 + DB 层

**Files:**
- Create: `api/requirements.txt`、`api/schema.sql`、`api/app/__init__.py`、`api/app/db.py`、`api/tests/conftest.py`、`api/tests/test_db.py`

**Interfaces:**
- Consumes: 无
- Produces: `app.db.connect() -> sqlite3.Connection`（row_factory=Row、外键开启）、`app.db.init_db() -> None`（建表幂等）、`app.db.get_db()`（FastAPI 依赖，yield 连接）、`app.db.db_path() -> str`（读 `SEO_OPS_DB` 环境变量，默认 `data/seo-ops-v3.db`）；测试 fixture `client`（Task 3 起使用）

- [ ] **Step 1: 建目录与虚拟环境，装依赖**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
mkdir -p api/app api/tests
python3 -m venv api/.venv
```

写入 `api/requirements.txt`：

```
fastapi
uvicorn[standard]
pytest
httpx
```

```bash
api/.venv/bin/pip install -r api/requirements.txt
```

- [ ] **Step 2: 写 schema.sql**

写入 `api/schema.sql`：

```sql
CREATE TABLE IF NOT EXISTS merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
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

CREATE INDEX IF NOT EXISTS idx_tasks_merchant ON tasks(merchant_id);
```

- [ ] **Step 3: 写失败测试**

写入 `api/tests/conftest.py`：

```python
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SEO_OPS_DB", str(tmp_path / "test.db"))
    from app.db import init_db

    init_db()
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c
```

写入 `api/tests/test_db.py`：

```python
import sqlite3


def test_init_db_creates_tables(tmp_path, monkeypatch):
    monkeypatch.setenv("SEO_OPS_DB", str(tmp_path / "t.db"))
    from app.db import init_db

    init_db()
    init_db()  # 幂等
    conn = sqlite3.connect(tmp_path / "t.db")
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    conn.close()
    assert {"merchants", "tasks"} <= names
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd api && .venv/bin/python -m pytest tests/test_db.py -v`
Expected: FAIL（`ModuleNotFoundError: No module named 'app.db'` 或类似）

- [ ] **Step 5: 实现 db.py**

创建空文件 `api/app/__init__.py`。写入 `api/app/db.py`：

```python
import os
import sqlite3
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"
DEFAULT_DB_PATH = Path(__file__).resolve().parents[2] / "data" / "seo-ops-v3.db"


def db_path() -> str:
    return os.environ.get("SEO_OPS_DB", str(DEFAULT_DB_PATH))


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    Path(db_path()).parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        conn.executescript(SCHEMA_PATH.read_text())
        conn.commit()
    finally:
        conn.close()


def get_db():
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd api && .venv/bin/python -m pytest tests/test_db.py -v`
Expected: PASS（conftest 里引用的 `app.main` 尚不存在，但 `test_db.py` 不用 `client` fixture，不受影响）

- [ ] **Step 7: Commit**

```bash
git add api/requirements.txt api/schema.sql api/app/__init__.py api/app/db.py api/tests/conftest.py api/tests/test_db.py
git commit -m "feat(api): scaffold FastAPI backend with sqlite schema and db layer"
```

---

### Task 3: 商户接口

**Files:**
- Create: `api/app/merchants.py`、`api/app/main.py`
- Test: `api/tests/test_merchants.py`

**Interfaces:**
- Consumes: `app.db.get_db`、`app.db.init_db`
- Produces: FastAPI 应用 `app.main.app`；路由 `GET/POST /api/merchants`、`GET/PATCH/DELETE /api/merchants/{id}`；供 Task 4 复用的 `app.merchants.fetch_merchant(conn, merchant_id) -> sqlite3.Row`（不存在则抛 404 HTTPException）和 `app.merchants.now_iso() -> str`

- [ ] **Step 1: 写失败测试**

写入 `api/tests/test_merchants.py`：

```python
import os
import sqlite3


def test_create_and_get_merchant(client):
    res = client.post("/api/merchants", json={"name": "Alpha", "notes": "first"})
    assert res.status_code == 201
    m = res.json()
    assert m["name"] == "Alpha"
    assert m["status"] == "active"
    assert m["notes"] == "first"
    assert m["created_at"]
    assert client.get(f"/api/merchants/{m['id']}").json()["name"] == "Alpha"


def test_create_merchant_rejects_empty_name(client):
    assert client.post("/api/merchants", json={"name": ""}).status_code == 422


def test_get_missing_merchant_404(client):
    assert client.get("/api/merchants/999").status_code == 404


def test_list_merchants_filter_by_status(client):
    a = client.post("/api/merchants", json={"name": "A"}).json()
    b = client.post("/api/merchants", json={"name": "B"}).json()
    client.patch(f"/api/merchants/{b['id']}", json={"status": "archived"})
    assert [m["id"] for m in client.get("/api/merchants", params={"status": "active"}).json()] == [a["id"]]
    assert [m["id"] for m in client.get("/api/merchants", params={"status": "archived"}).json()] == [b["id"]]
    assert len(client.get("/api/merchants").json()) == 2


def test_patch_merchant_fields(client):
    m = client.post("/api/merchants", json={"name": "Old"}).json()
    res = client.patch(f"/api/merchants/{m['id']}", json={"name": "New", "notes": "n2"})
    assert res.status_code == 200
    assert res.json()["name"] == "New"
    assert res.json()["notes"] == "n2"


def test_patch_merchant_rejects_bad_status(client):
    m = client.post("/api/merchants", json={"name": "M"}).json()
    assert client.patch(f"/api/merchants/{m['id']}", json={"status": "frozen"}).status_code == 422


def test_delete_merchant_without_tasks(client):
    m = client.post("/api/merchants", json={"name": "Gone"}).json()
    assert client.delete(f"/api/merchants/{m['id']}").status_code == 204
    assert client.get(f"/api/merchants/{m['id']}").status_code == 404


def test_delete_merchant_with_tasks_conflicts(client):
    m = client.post("/api/merchants", json={"name": "Busy"}).json()
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO tasks (merchant_id, title, created_at) VALUES (?, 't', '2026-08-31T00:00:00+00:00')",
        (m["id"],),
    )
    conn.commit()
    conn.close()
    assert client.delete(f"/api/merchants/{m['id']}").status_code == 409
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && .venv/bin/python -m pytest tests/test_merchants.py -v`
Expected: FAIL（conftest 导入 `app.main` 报 `ModuleNotFoundError`）

- [ ] **Step 3: 实现 merchants.py 和 main.py**

写入 `api/app/merchants.py`：

```python
import sqlite3
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .db import get_db

router = APIRouter(prefix="/api/merchants", tags=["merchants"])


class MerchantCreate(BaseModel):
    name: str = Field(min_length=1)
    notes: str | None = None


class MerchantPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    status: Literal["active", "archived"] | None = None
    notes: str | None = None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def fetch_merchant(conn: sqlite3.Connection, merchant_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM merchants WHERE id = ?", (merchant_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="merchant not found")
    return row


@router.get("")
def list_merchants(status: Literal["active", "archived"] | None = None, conn=Depends(get_db)):
    if status:
        rows = conn.execute("SELECT * FROM merchants WHERE status = ? ORDER BY id DESC", (status,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM merchants ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]


@router.post("", status_code=201)
def create_merchant(body: MerchantCreate, conn=Depends(get_db)):
    cur = conn.execute(
        "INSERT INTO merchants (name, notes, created_at) VALUES (?, ?, ?)",
        (body.name, body.notes, now_iso()),
    )
    conn.commit()
    return dict(fetch_merchant(conn, cur.lastrowid))


@router.get("/{merchant_id}")
def get_merchant(merchant_id: int, conn=Depends(get_db)):
    return dict(fetch_merchant(conn, merchant_id))


@router.patch("/{merchant_id}")
def patch_merchant(merchant_id: int, body: MerchantPatch, conn=Depends(get_db)):
    fetch_merchant(conn, merchant_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        conn.execute(f"UPDATE merchants SET {field} = ? WHERE id = ?", (value, merchant_id))
    conn.commit()
    return dict(fetch_merchant(conn, merchant_id))


@router.delete("/{merchant_id}", status_code=204)
def delete_merchant(merchant_id: int, conn=Depends(get_db)):
    fetch_merchant(conn, merchant_id)
    n = conn.execute("SELECT COUNT(*) AS n FROM tasks WHERE merchant_id = ?", (merchant_id,)).fetchone()["n"]
    if n:
        raise HTTPException(status_code=409, detail="merchant has tasks; archive it instead")
    conn.execute("DELETE FROM merchants WHERE id = ?", (merchant_id,))
    conn.commit()
```

写入 `api/app/main.py`：

```python
from fastapi import FastAPI

from .db import init_db
from .merchants import router as merchants_router

init_db()
app = FastAPI(title="SEO Ops API")
app.include_router(merchants_router)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd api && .venv/bin/python -m pytest tests -v`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add api/app/merchants.py api/app/main.py api/tests/test_merchants.py
git commit -m "feat(api): merchant CRUD with status filter and delete guard"
```

---

### Task 4: 任务接口

**Files:**
- Create: `api/app/tasks.py`
- Modify: `api/app/main.py`
- Test: `api/tests/test_tasks.py`

**Interfaces:**
- Consumes: `app.db.get_db`、`app.merchants.fetch_merchant`、`app.merchants.now_iso`
- Produces: 路由 `GET/POST /api/merchants/{id}/tasks`、`GET/PATCH /api/tasks/{id}`；返回的 task JSON 字段：`id, merchant_id, title, description, rationale, status, evidence_note, created_at, completed_at`（前端 Task 5 依赖此结构）

- [ ] **Step 1: 写失败测试**

写入 `api/tests/test_tasks.py`：

```python
def make_merchant(client):
    return client.post("/api/merchants", json={"name": "M"}).json()


def make_task(client, merchant_id, **extra):
    return client.post(f"/api/merchants/{merchant_id}/tasks", json={"title": "t", **extra}).json()


def test_create_and_list_tasks(client):
    m = make_merchant(client)
    res = client.post(
        f"/api/merchants/{m['id']}/tasks",
        json={"title": "Fix GBP", "rationale": "ranking dropped", "description": "check listing"},
    )
    assert res.status_code == 201
    t = res.json()
    assert t["merchant_id"] == m["id"]
    assert t["status"] == "todo"
    assert t["rationale"] == "ranking dropped"
    assert t["evidence_note"] is None
    assert t["completed_at"] is None
    assert [x["id"] for x in client.get(f"/api/merchants/{m['id']}/tasks").json()] == [t["id"]]


def test_create_task_rejects_empty_title(client):
    m = make_merchant(client)
    assert client.post(f"/api/merchants/{m['id']}/tasks", json={"title": ""}).status_code == 422


def test_task_endpoints_404_on_missing(client):
    assert client.post("/api/merchants/999/tasks", json={"title": "t"}).status_code == 404
    assert client.get("/api/merchants/999/tasks").status_code == 404
    assert client.get("/api/tasks/999").status_code == 404
    assert client.patch("/api/tasks/999", json={"status": "doing"}).status_code == 404


def test_legal_transitions_todo_doing_done(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    assert client.patch(f"/api/tasks/{t['id']}", json={"status": "doing"}).json()["status"] == "doing"
    done = client.patch(f"/api/tasks/{t['id']}", json={"status": "done"}).json()
    assert done["status"] == "done"
    assert done["completed_at"] is not None


def test_todo_straight_to_done_is_422(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    assert client.patch(f"/api/tasks/{t['id']}", json={"status": "done"}).status_code == 422


def test_cancel_from_todo_and_doing(client):
    m = make_merchant(client)
    t1 = make_task(client, m["id"])
    assert client.patch(f"/api/tasks/{t1['id']}", json={"status": "cancelled"}).json()["status"] == "cancelled"
    t2 = make_task(client, m["id"])
    client.patch(f"/api/tasks/{t2['id']}", json={"status": "doing"})
    assert client.patch(f"/api/tasks/{t2['id']}", json={"status": "cancelled"}).json()["status"] == "cancelled"


def test_terminal_states_reject_transitions(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    client.patch(f"/api/tasks/{t['id']}", json={"status": "cancelled"})
    for s in ("todo", "doing", "done"):
        assert client.patch(f"/api/tasks/{t['id']}", json={"status": s}).status_code == 422


def test_same_status_patch_is_noop(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    assert client.patch(f"/api/tasks/{t['id']}", json={"status": "todo"}).status_code == 200


def test_patch_text_fields(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    res = client.patch(
        f"/api/tasks/{t['id']}",
        json={"rationale": "because", "evidence_note": "did it", "title": "T2", "description": "d2"},
    )
    body = res.json()
    assert body["rationale"] == "because"
    assert body["evidence_note"] == "did it"
    assert body["title"] == "T2"
    assert body["description"] == "d2"
    assert body["status"] == "todo"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && .venv/bin/python -m pytest tests/test_tasks.py -v`
Expected: FAIL（404 Not Found——路由不存在）

- [ ] **Step 3: 实现 tasks.py 并挂到 main**

写入 `api/app/tasks.py`：

```python
import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .db import get_db
from .merchants import fetch_merchant, now_iso

router = APIRouter(prefix="/api", tags=["tasks"])

ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "todo": {"doing", "cancelled"},
    "doing": {"done", "cancelled"},
    "done": set(),
    "cancelled": set(),
}


class TaskCreate(BaseModel):
    title: str = Field(min_length=1)
    description: str | None = None
    rationale: str | None = None


class TaskPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    description: str | None = None
    rationale: str | None = None
    evidence_note: str | None = None
    status: Literal["todo", "doing", "done", "cancelled"] | None = None


def fetch_task(conn: sqlite3.Connection, task_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    return row


@router.get("/merchants/{merchant_id}/tasks")
def list_tasks(merchant_id: int, conn=Depends(get_db)):
    fetch_merchant(conn, merchant_id)
    rows = conn.execute("SELECT * FROM tasks WHERE merchant_id = ? ORDER BY id DESC", (merchant_id,)).fetchall()
    return [dict(r) for r in rows]


@router.post("/merchants/{merchant_id}/tasks", status_code=201)
def create_task(merchant_id: int, body: TaskCreate, conn=Depends(get_db)):
    fetch_merchant(conn, merchant_id)
    cur = conn.execute(
        "INSERT INTO tasks (merchant_id, title, description, rationale, created_at) VALUES (?, ?, ?, ?, ?)",
        (merchant_id, body.title, body.description, body.rationale, now_iso()),
    )
    conn.commit()
    return dict(fetch_task(conn, cur.lastrowid))


@router.get("/tasks/{task_id}")
def get_task(task_id: int, conn=Depends(get_db)):
    return dict(fetch_task(conn, task_id))


@router.patch("/tasks/{task_id}")
def patch_task(task_id: int, body: TaskPatch, conn=Depends(get_db)):
    task = fetch_task(conn, task_id)
    updates = body.model_dump(exclude_unset=True)
    new_status = updates.pop("status", None)
    for field, value in updates.items():
        conn.execute(f"UPDATE tasks SET {field} = ? WHERE id = ?", (value, task_id))
    if new_status is not None and new_status != task["status"]:
        if new_status not in ALLOWED_TRANSITIONS[task["status"]]:
            raise HTTPException(status_code=422, detail=f"illegal transition {task['status']} -> {new_status}")
        completed_at = now_iso() if new_status == "done" else None
        conn.execute("UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?", (new_status, completed_at, task_id))
    conn.commit()
    return dict(fetch_task(conn, task_id))
```

修改 `api/app/main.py` 为：

```python
from fastapi import FastAPI

from .db import init_db
from .merchants import router as merchants_router
from .tasks import router as tasks_router

init_db()
app = FastAPI(title="SEO Ops API")
app.include_router(merchants_router)
app.include_router(tasks_router)
```

- [ ] **Step 4: 跑全部后端测试确认通过**

Run: `cd api && .venv/bin/python -m pytest tests -v`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add api/app/tasks.py api/app/main.py api/tests/test_tasks.py
git commit -m "feat(api): task CRUD with status transition rules and evidence fields"
```

---

### Task 5: 前端脚手架 + API client

**Files:**
- Create: `web/`（Vite react-ts 模板）、`web/src/api.ts`
- Modify: `web/vite.config.ts`、`web/src/App.tsx`、`web/src/main.tsx`、`web/src/index.css`
- Delete: `web/src/App.css`、`web/src/assets/`（模板样板）

**Interfaces:**
- Consumes: Task 4 的 REST 接口与 JSON 字段
- Produces: `web/src/api.ts` 导出 `api` 对象与类型 `Merchant`、`Task`、`TaskStatus`（签名见下，Task 6–8 直接 import）；路由骨架 `/`、`/merchants/:id`、`/tasks/:id`

- [ ] **Step 1: 脚手架与依赖**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
npm create vite@latest web -- --template react-ts
cd web
npm install
npm install react-router-dom
```

- [ ] **Step 2: 配置 /api 代理**

覆写 `web/vite.config.ts`：

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
```

- [ ] **Step 3: 写 API client**

写入 `web/src/api.ts`：

```ts
export type Merchant = {
  id: number
  name: string
  status: 'active' | 'archived'
  notes: string | null
  created_at: string
}

export type TaskStatus = 'todo' | 'doing' | 'done' | 'cancelled'

export type Task = {
  id: number
  merchant_id: number
  title: string
  description: string | null
  rationale: string | null
  status: TaskStatus
  evidence_note: string | null
  created_at: string
  completed_at: string | null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const detail = body && typeof body.detail === 'string' ? body.detail : `${res.status} ${res.statusText}`
    throw new Error(detail)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  listMerchants: (status?: 'active' | 'archived') =>
    request<Merchant[]>(`/api/merchants${status ? `?status=${status}` : ''}`),
  createMerchant: (body: { name: string; notes?: string }) =>
    request<Merchant>('/api/merchants', { method: 'POST', body: JSON.stringify(body) }),
  getMerchant: (id: number) => request<Merchant>(`/api/merchants/${id}`),
  patchMerchant: (id: number, body: Partial<Pick<Merchant, 'name' | 'status' | 'notes'>>) =>
    request<Merchant>(`/api/merchants/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  listTasks: (merchantId: number) => request<Task[]>(`/api/merchants/${merchantId}/tasks`),
  createTask: (merchantId: number, body: { title: string; description?: string; rationale?: string }) =>
    request<Task>(`/api/merchants/${merchantId}/tasks`, { method: 'POST', body: JSON.stringify(body) }),
  getTask: (id: number) => request<Task>(`/api/tasks/${id}`),
  patchTask: (id: number, body: Partial<Pick<Task, 'title' | 'description' | 'rationale' | 'evidence_note' | 'status'>>) =>
    request<Task>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
}
```

- [ ] **Step 4: 路由骨架与全局样式**

覆写 `web/src/App.tsx`（页面组件 Task 6–8 才创建，先用占位组件让骨架可构建）：

```tsx
import { BrowserRouter, Route, Routes } from 'react-router-dom'

const Placeholder = ({ name }: { name: string }) => <main><h1>{name}</h1></main>

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Placeholder name="商户列表" />} />
        <Route path="/merchants/:id" element={<Placeholder name="商户详情" />} />
        <Route path="/tasks/:id" element={<Placeholder name="任务详情" />} />
      </Routes>
    </BrowserRouter>
  )
}
```

覆写 `web/src/main.tsx`：

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

覆写 `web/src/index.css`：

```css
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0 auto; max-width: 720px; padding: 24px; line-height: 1.6; }
main h1 { margin-top: 0; }
form { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
input, textarea { padding: 6px 8px; font: inherit; flex: 1; min-width: 160px; }
textarea { width: 100%; box-sizing: border-box; }
button { padding: 6px 12px; font: inherit; cursor: pointer; }
.list { list-style: none; padding: 0; }
.list li { display: flex; gap: 8px; align-items: baseline; padding: 6px 0; border-bottom: 1px solid #8883; }
.badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid #8886; margin-right: 8px; }
.muted { color: #888; font-size: 13px; }
.error { color: #c00; }
.filters { display: flex; gap: 8px; margin: 8px 0; }
```

删除 `web/src/App.css` 与 `web/src/assets/` 目录。把 `web/index.html` 的 `<title>` 改为 `SEO Ops`。

- [ ] **Step 5: 构建验证**

Run: `cd web && npm run build`
Expected: 构建成功，无 TS 错误

- [ ] **Step 6: Commit**

```bash
git add web
git commit -m "feat(web): scaffold Vite react-ts app with API client and route skeleton"
```

---

### Task 6: 商户列表页

**Files:**
- Create: `web/src/pages/MerchantList.tsx`
- Modify: `web/src/App.tsx`（`/` 路由换成真组件）

**Interfaces:**
- Consumes: `api.listMerchants`、`api.createMerchant`、类型 `Merchant`
- Produces: 页面 `/`：状态筛选（在营/已归档/全部）、新建商户表单、商户链接到 `/merchants/:id`

- [ ] **Step 1: 实现页面**

写入 `web/src/pages/MerchantList.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Merchant } from '../api'

export default function MerchantList() {
  const [merchants, setMerchants] = useState<Merchant[]>([])
  const [filter, setFilter] = useState<'all' | 'active' | 'archived'>('active')
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.listMerchants(filter === 'all' ? undefined : filter)
      .then(ms => { setMerchants(ms); setError('') })
      .catch(e => setError((e as Error).message))
  }, [filter])

  useEffect(load, [load])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    try {
      await api.createMerchant({ name: name.trim(), notes: notes.trim() || undefined })
      setName('')
      setNotes('')
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <main>
      <h1>商户台账</h1>
      {error && <p className="error">{error}</p>}
      <form onSubmit={create}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="商户名称" />
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="备注（可选）" />
        <button type="submit">新建商户</button>
      </form>
      <div className="filters">
        {(['active', 'archived', 'all'] as const).map(f => (
          <button key={f} disabled={filter === f} onClick={() => setFilter(f)}>
            {f === 'active' ? '在营' : f === 'archived' ? '已归档' : '全部'}
          </button>
        ))}
      </div>
      <ul className="list">
        {merchants.map(m => (
          <li key={m.id}>
            <Link to={`/merchants/${m.id}`}>{m.name}</Link>
            <span className={`badge ${m.status}`}>{m.status === 'active' ? '在营' : '已归档'}</span>
            {m.notes && <span className="muted">{m.notes}</span>}
          </li>
        ))}
      </ul>
    </main>
  )
}
```

修改 `web/src/App.tsx`：顶部加 `import MerchantList from './pages/MerchantList'`，把 `/` 路由的 element 换成 `<MerchantList />`。

- [ ] **Step 2: 构建验证**

Run: `cd web && npm run build`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/MerchantList.tsx web/src/App.tsx
git commit -m "feat(web): merchant list page with create form and status filter"
```

---

### Task 7: 商户详情页

**Files:**
- Create: `web/src/pages/MerchantDetail.tsx`
- Modify: `web/src/App.tsx`（`/merchants/:id` 路由换成真组件）

**Interfaces:**
- Consumes: `api.getMerchant`、`api.patchMerchant`、`api.listTasks`、`api.createTask`、类型 `Merchant`、`Task`、`TaskStatus`
- Produces: 页面 `/merchants/:id`：商户信息、归档/恢复按钮、按状态分组的任务列表（链接到 `/tasks/:id`）、新建任务表单（标题+动因+描述）

- [ ] **Step 1: 实现页面**

写入 `web/src/pages/MerchantDetail.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type Merchant, type Task, type TaskStatus } from '../api'

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  cancelled: '已取消',
}
const STATUS_ORDER: TaskStatus[] = ['todo', 'doing', 'done', 'cancelled']

export default function MerchantDetail() {
  const { id } = useParams()
  const merchantId = Number(id)
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [title, setTitle] = useState('')
  const [rationale, setRationale] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.getMerchant(merchantId).then(setMerchant).catch(e => setError((e as Error).message))
    api.listTasks(merchantId).then(setTasks).catch(e => setError((e as Error).message))
  }, [merchantId])

  useEffect(load, [load])

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

修改 `web/src/App.tsx`：加 `import MerchantDetail from './pages/MerchantDetail'`，把 `/merchants/:id` 路由的 element 换成 `<MerchantDetail />`。

- [ ] **Step 2: 构建验证**

Run: `cd web && npm run build`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/MerchantDetail.tsx web/src/App.tsx
git commit -m "feat(web): merchant detail page with grouped tasks and task creation"
```

---

### Task 8: 任务详情页

**Files:**
- Create: `web/src/pages/TaskDetail.tsx`
- Modify: `web/src/App.tsx`（`/tasks/:id` 路由换成真组件，删掉 Placeholder）

**Interfaces:**
- Consumes: `api.getTask`、`api.patchTask`、类型 `Task`、`TaskStatus`
- Produces: 页面 `/tasks/:id`：展示动因/描述、按当前状态给出合法流转按钮、证据文本编辑保存

- [ ] **Step 1: 实现页面**

写入 `web/src/pages/TaskDetail.tsx`：

```tsx
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type Task, type TaskStatus } from '../api'

const NEXT: Record<TaskStatus, TaskStatus[]> = {
  todo: ['doing', 'cancelled'],
  doing: ['done', 'cancelled'],
  done: [],
  cancelled: [],
}
const LABELS: Record<TaskStatus, string> = { todo: '待办', doing: '进行中', done: '已完成', cancelled: '已取消' }

export default function TaskDetail() {
  const { id } = useParams()
  const taskId = Number(id)
  const [task, setTask] = useState<Task | null>(null)
  const [evidence, setEvidence] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.getTask(taskId)
      .then(t => { setTask(t); setEvidence(t.evidence_note ?? '') })
      .catch(e => setError((e as Error).message))
  }, [taskId])

  const transition = async (status: TaskStatus) => {
    try {
      setTask(await api.patchTask(taskId, { status }))
      setError('')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const saveEvidence = async () => {
    try {
      setTask(await api.patchTask(taskId, { evidence_note: evidence }))
      setError('')
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (!task) {
    return (
      <main>
        <p><Link to="/">← 商户列表</Link></p>
        {error ? <p className="error">{error}</p> : <p>加载中…</p>}
      </main>
    )
  }

  return (
    <main>
      <p><Link to={`/merchants/${task.merchant_id}`}>← 返回商户</Link></p>
      <h1>{task.title}</h1>
      <p><span className={`badge ${task.status}`}>{LABELS[task.status]}</span></p>
      {error && <p className="error">{error}</p>}

      <h2>为什么做</h2>
      <p>{task.rationale || <span className="muted">（未填写）</span>}</p>
      {task.description && (
        <>
          <h2>描述</h2>
          <p>{task.description}</p>
        </>
      )}

      {NEXT[task.status].length > 0 && (
        <p>
          {NEXT[task.status].map(s => (
            <button key={s} onClick={() => transition(s)} style={{ marginRight: 8 }}>
              转为{LABELS[s]}
            </button>
          ))}
        </p>
      )}

      <h2>执行证据</h2>
      <textarea
        rows={6}
        value={evidence}
        onChange={e => setEvidence(e.target.value)}
        placeholder="做了什么、结果如何；需要截图先贴链接"
      />
      <p>
        <button onClick={saveEvidence}>保存证据</button>
        {saved && <span className="muted"> 已保存</span>}
      </p>

      <p className="muted">创建于 {task.created_at}{task.completed_at ? ` · 完成于 ${task.completed_at}` : ''}</p>
    </main>
  )
}
```

修改 `web/src/App.tsx` 为最终形态：

```tsx
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import MerchantList from './pages/MerchantList'
import MerchantDetail from './pages/MerchantDetail'
import TaskDetail from './pages/TaskDetail'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MerchantList />} />
        <Route path="/merchants/:id" element={<MerchantDetail />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
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
git add web/src/pages/TaskDetail.tsx web/src/App.tsx
git commit -m "feat(web): task detail page with transitions and evidence editing"
```

---

### Task 9: 联调冒烟 + README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: 全部前后端
- Produces: 可复现的运行说明；冒烟验证记录

- [ ] **Step 1: 起后端并冒烟**

```bash
cd /Users/xander/git_repo/connexup-seo-ops/api
.venv/bin/uvicorn app.main:app --port 8000 &
sleep 2
curl -s -X POST localhost:8000/api/merchants -H 'Content-Type: application/json' -d '{"name":"冒烟商户"}'
curl -s localhost:8000/api/merchants
```

Expected: 两个请求都返回含 `"name":"冒烟商户"` 的 JSON；`data/seo-ops-v3.db` 被创建。

- [ ] **Step 2: 起前端并验证代理**

```bash
cd /Users/xander/git_repo/connexup-seo-ops/web
npm run dev &
sleep 3
curl -s localhost:5173/api/merchants
```

Expected: 经 Vite 代理返回与 Step 1 相同的商户列表 JSON。随后在浏览器打开 http://localhost:5173 人工过一遍：新建商户 → 进详情建任务（填动因）→ 进任务详情流转状态、填证据。验证完停掉两个后台进程。

- [ ] **Step 3: 写 README**

写入 `README.md`：

```markdown
# connexup-seo-ops

商户 SEO 运营台账（重建版，一次一块砖）。当前砖：商户台账 + 任务工单。
设计文档：docs/superpowers/specs/2026-08-31-seo-ops-rebuild-slice1-design.md

## 结构

- `api/` — FastAPI + SQLite 后端（库文件 `data/seo-ops-v3.db`，schema 见 `api/schema.sql`）
- `web/` — React + Vite + TS 前端（开发期 `/api` 代理到 8000）

## 开发运行

后端：

    cd api
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/uvicorn app.main:app --reload --port 8000

前端：

    cd web
    npm install
    npm run dev

浏览器打开 http://localhost:5173 。接口文档在 http://localhost:8000/docs 。

## 测试

    cd api && .venv/bin/python -m pytest tests -v
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add README with run instructions for slice 1"
```
