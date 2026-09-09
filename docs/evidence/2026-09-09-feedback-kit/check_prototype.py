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
