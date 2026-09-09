#!/usr/bin/env python3
"""Acceptance check for the AM workspace prototype (AM OS design spec, section 13)."""
from __future__ import annotations
import re, sys
from pathlib import Path

PROTO = Path(__file__).resolve().parent / "prototype"
REQUIRED_SECTIONS = ["am-home", "am-merchant-space", "am-task-detail", "am-task-detail-human", "am-dispatch-drawer", "am-team"]
REQUIRED_COPY = [
    "工作台", "商户", "任务与计划", "数据与报告", "团队",
    "需要我决定", "分派给我", "需要关注", "仅知会",
    "GBP 帖子草稿等你批准", "Q4 周期 Plan 待批准", "Local Falcon 扫描将消耗 40 credits",
    "确认 Weekday Brunch Set 的价格与有效期", "GSC 授权已过期", "上一次发布结果未知",
    "当前 Plan", "WAITING_AUTHORIZATION", "验收标准", "提交确认结果", "转交给",
    "CREATE_TASK", "REQUEST_HUMAN_INPUT", "已派单", "绑定漂移",
    "active 只表示注册状态，不代表远端可用或本次已调用",
]
EXTERNAL = re.compile(r"""(?:<link[^>]+href|<script[^>]+src|@import\s+(?:url\()?|url\()\s*["']?https?://""", re.I)

def main() -> int:
    html_path = PROTO / "index.html"
    if not html_path.is_file():
        print(f"FAIL: {html_path} missing"); return 1
    html = html_path.read_text("utf-8", errors="replace")
    failures = []
    for sid in REQUIRED_SECTIONS:
        if not re.search(rf"""<section[^>]*\bid\s*=\s*["']{sid}["']""", html):
            failures.append(f'missing <section id="{sid}">')
    for text in REQUIRED_COPY:
        if text not in html:
            failures.append(f"missing copy: {text}")
    for m in EXTERNAL.finditer(html):
        failures.append(f"external resource: {html[m.start():m.start()+80]!r}")
    if failures:
        print("FAIL"); [print(" -", f) for f in failures]; return 1
    print(f"PASS: {len(REQUIRED_SECTIONS)} sections, {len(REQUIRED_COPY)} copy strings, no external resources"); return 0

if __name__ == "__main__":
    sys.exit(main())
