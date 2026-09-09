#!/usr/bin/env python3
"""Acceptance check for the GBP Post task UI prototype (spec 2026-09-09-gbp-post-task-design, section 13)."""
from __future__ import annotations
import re, sys
from pathlib import Path

PROTO = Path(__file__).resolve().parent / "prototype"
REQUIRED_SECTIONS = [
    "task-preparing", "task-preparing-blocked", "task-awaiting-approval", "task-approve-dialog",
    "task-executing", "task-verifying", "task-done", "task-needs-attention", "merchant-and-profile",
]
REQUIRED_COPY = [
    "内容 Agent 准备中", "该商户尚未填写风格档案，内容 Agent 无法开始。", "批准并发布", "退回重新准备",
    "批准后由发布 Agent 写入 Google，不能撤回；发布后如需修改，请新建补偿任务。",
    "发布 Agent 会把这一版内容和图片写入 Google 门店 2020 Broadway。发布后不能撤回，只能新建补偿任务修改。确认发布？",
    "发布 Agent 执行中，页面每 10 秒刷新", "立即重新核对", "已上线",
    "Google 上读到 2 条内容完全一致的帖子，无法确定哪一条是本次发布。", "重新核对", "精确匹配",
    "补救请新建补偿任务，本任务不可修改。", "内容和图片由 Agent 生成，你只审批", "本期活动与优惠", "风格档案", "上传真实照片",
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
    if "prefers-reduced-motion" not in html:
        failures.append("no prefers-reduced-motion rule")
    if failures:
        print("FAIL"); [print(" -", f) for f in failures]; return 1
    print(f"PASS: {len(REQUIRED_SECTIONS)} sections, {len(REQUIRED_COPY)} copy strings, no external resources"); return 0

if __name__ == "__main__":
    sys.exit(main())
