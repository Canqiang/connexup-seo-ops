#!/usr/bin/env python3
"""Acceptance check for the AM workspace prototype v5 (interactive single file, prompt-v5.md).

Static part: demo-data JSON exists and is self-consistent, routes referenced by links/buttons match the
route table, retired copy is absent, no external resources. The click-through itself is verified in a
real browser (see run.json "browserCheck")."""
from __future__ import annotations
import json, re, sys
from pathlib import Path

PROTO = Path(__file__).resolve().parent / "prototype"
ROUTES = [
    r"#/$", r"#/merchants(\?.*)?$", r"#/merchants/[a-z0-9-]+$", r"#/merchants/[a-z0-9-]+/(plans|performance|audit|profile|reports)(\?.*)?$",
    r"#/audits/[A-Za-z0-9-]+$", r"#/audits/[A-Za-z0-9-]+/compare/[A-Za-z0-9-]+$",
    r"#/reports/[A-Za-z0-9-]+/v/\d+(/review)?$", r"#/work-orders/[A-Za-z0-9-]+(\?.*)?$", r"#/tasks/[A-Za-z0-9-]+$",
    r"#/plans/[A-Za-z0-9-]+$", r"#/team(/models|/members/[A-Za-z0-9-]+|/skills/[A-Za-z0-9-]+)?$", r"#/exceptions$",
    r"#/keywords/[^#]+$", r"#/memory/.+$",
]
REQUIRED_COPY = [
    "草稿任务", "人工审核任务", "发布任务", "包含远端核验", "T-1198", "T-1199", "T-1200",
    "授权数据缺失", "公开网站检查", "最近有效结果", "不可直接比较",
    "查看报告", "交付记录", "有更新的来源数据", "生成修订版", "模拟补数", "已补齐",
    "历史缺失记录", "当前状态", "仅本工作单", "涉及商户", "2026-Q3", "已入队", "内容已变化", "重新载入",
    "上次发布结果未知，需要你核验", "不会自动重发", "演示：刷新后重置",
]
FORBIDDEN_COPY = ["批准并发布", "标记为无法完成", "应用提案", "批准扫描", "会一直等待，需要重新派单", "Q4 · 第 2 周", "发布成功"]
EXTERNAL = re.compile(r"""(?:<link[^>]+href|<script[^>]+src|@import\s+(?:url\()?|url\()\s*["']?https?://""", re.I)
norm = lambda s: re.sub(r"[\s·]+", "", re.sub(r"<[^>]+>", "", s))

def main() -> int:
    html_path = PROTO / "index.html"
    if not html_path.is_file():
        print(f"FAIL: {html_path} missing"); return 1
    html = html_path.read_text("utf-8", errors="replace")
    failures = []
    m = re.search(r'<script[^>]*type="application/json"[^>]*id="demo-data"[^>]*>(.*?)</script>', html, re.S) or \
        re.search(r'<script[^>]*id="demo-data"[^>]*type="application/json"[^>]*>(.*?)</script>', html, re.S)
    data = None
    if not m:
        failures.append("missing <script type=application/json id=demo-data>")
    else:
        try:
            data = json.loads(m.group(1))
        except json.JSONDecodeError as exc:
            failures.append(f"demo-data is not valid JSON: {exc}")
    if isinstance(data, dict):
        for key in ["merchants", "inbox", "audits", "performance", "scans", "reports", "workOrders", "tasks"]:
            if key not in data:
                failures.append(f"demo-data missing key: {key}")
        merchants = data.get("merchants") or []
        if len(merchants) != 5:
            failures.append(f"expected 5 merchants, got {len(merchants)}")
        merchant_ids = {mm.get("id") for mm in merchants}
        inbox = data.get("inbox") or []
        for item in inbox:
            if item.get("merchantId") not in merchant_ids:
                failures.append(f"inbox item {item.get('id')} references unknown merchant {item.get('merchantId')}")
            if item.get("scope") == "task" and "商户" in (item.get("scopeText") or "") and "仅" not in (item.get("scopeText") or ""):
                failures.append(f"inbox item {item.get('id')}: task-level scope described as merchant-wide")
        for scan in data.get("scans") or []:
            arp, atrp = scan.get("arp"), scan.get("atrp")
            if isinstance(arp, (int, float)) and isinstance(atrp, (int, float)) and atrp < arp:
                failures.append(f"scan {scan.get('id')}: ATRP {atrp} < ARP {arp}")
            for kw, row in (scan.get("kw") or {}).items():
                if isinstance(row, dict) and isinstance(row.get("atrp"), (int, float)) and isinstance(row.get("rank"), (int, float)) and row["atrp"] < row["rank"]:
                    failures.append(f"scan {scan.get('id')} keyword {kw}: ATRP {row['atrp']} < ARP {row['rank']}")
        for audit in data.get("audits") or []:
            dims = audit.get("dimensions") or {}
            scored = [v for v in dims.values() if isinstance(v, (int, float))] if isinstance(dims, dict) else []
            total = audit.get("total")
            status = (audit.get("status") or "").lower()
            if status == "failed" and total is not None:
                failures.append(f"audit {audit.get('id')}: failed run carries a score {total}")
            if audit.get("kind") == "full" and status != "failed" and scored:
                mean = sum(scored) / len(scored)
                if total is None or abs(mean - float(total)) > 0.6:
                    failures.append(f"audit {audit.get('id')}: total {total} != mean {mean:.1f} of {scored}")
        for wo in data.get("workOrders") or []:
            steps = wo.get("steps") or {}
            task_ids = [s.get("taskId") if isinstance(s, dict) else s for s in steps.values()]
            task_ids = [t for t in task_ids if isinstance(t, str) and t]
            if len(set(task_ids)) < 3:
                failures.append(f"work order {wo.get('id')}: expected 3 distinct task ids in steps, got {task_ids}")
    for text in REQUIRED_COPY:
        if norm(text) not in norm(html):
            failures.append(f"missing copy: {text}")
    for text in FORBIDDEN_COPY:
        if norm(text) in norm(html):
            failures.append(f"forbidden copy present: {text}")
    for mm in EXTERNAL.finditer(html):
        failures.append(f"external resource: {html[mm.start():mm.start()+80]!r}")
    targets = {t for t in re.findall(r"""(?:href|data-target)\s*=\s*["'](#/[^"']*)["']""", html) if "${" not in t}
    bad = [t for t in targets if not any(re.match(p, t) for p in ROUTES)]
    for t in sorted(bad)[:20]:
        failures.append(f"target outside route table: {t}")
    # Buttons are rendered from JS templates; the source check only covers static markup outside <script>.
    static_html = re.sub(r"<script\b.*?</script>", "", html, flags=re.S | re.I)
    buttons = re.findall(r"<button\b[^>]*>", static_html, re.I)
    without = [b for b in buttons if "data-target" not in b]
    if without:
        failures.append(f"{len(without)} of {len(buttons)} static <button> without data-target, e.g. {without[0][:100]!r}")
    if failures:
        print("FAIL"); [print(" -", f) for f in failures]; return 1
    print(f"PASS: demo-data consistent, {len(targets)} static route targets valid, {len(buttons)} static buttons carry data-target (rendered DOM checked in browser), "
          f"{len(REQUIRED_COPY)} copy strings present, {len(FORBIDDEN_COPY)} retired strings absent, no external resources"); return 0

if __name__ == "__main__":
    sys.exit(main())
