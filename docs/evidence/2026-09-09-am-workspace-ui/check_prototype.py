#!/usr/bin/env python3
"""Acceptance check for the AM workspace prototype v2 (AM OS design spec §13 + prompt-v2.md)."""
from __future__ import annotations
import re, sys
from pathlib import Path

PROTO = Path(__file__).resolve().parent / "prototype"
REQUIRED_SECTIONS = [
    "am-home", "am-merchant-space", "am-gbp-work-order", "am-task-detail-human",
    "am-dispatch-drawer", "am-team", "am-memory", "am-model-cost", "am-reports",
]
REQUIRED_COPY = [
    # navigation + home groups
    "工作台", "商户", "任务与计划", "数据与报告", "团队",
    "需要我决定", "分派给我", "需要关注", "仅知会",
    # flow fix 1: in-scope auto dispatch vs out-of-scope group approval
    "已在 Plan #12 授权范围内创建并分派", "超出授权范围 · 需要你整体批准", "整体批准这 2 项",
    "范围内 2 项已派单 · 范围外 2 项等你批准", "已派单",
    # flow fix 2: review is a real human task inside a work order
    "GBP 内容工作单", "批准这一版", "退回并说明", "本版不含价格", "已解除对本版的阻塞",
    # flow fix 3: home only offers review
    "审阅草稿", "完整内容在审阅页",
    # flow fix 4: human task secondary actions
    "暂时受阻", "请求协助", "转交给", "取消任务", "提交确认结果",
    "确认 Weekday Brunch Set 的价格与有效期",
    # notification reclassification
    "审阅第 37 周周报草稿", "上次发布结果未知，需要你核验", "开始核验", "不会自动重发", "GSC 授权已过期",
    # merchant space / team
    "当前 Plan", "绑定漂移", "active 只表示注册状态，不代表远端可用或本次已调用",
    # new sections
    "已确认事实", "待确认经验", "Core AI 原生记忆", "确认为规则",
    "模型与成本", "升级条件", "预算规则", "模型是可替换的执行依赖",
    "Audit 报告", "周期表现报告", "生成报告不等于已发送", "记录交付", "冻结快照",
]
# Copy the v2 review explicitly removed; its presence means a flow fix regressed.
FORBIDDEN_COPY = ["批准并发布", "标记为无法完成", "应用提案"]
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
    for text in FORBIDDEN_COPY:
        if text in html:
            failures.append(f"forbidden copy present: {text}")
    for m in EXTERNAL.finditer(html):
        failures.append(f"external resource: {html[m.start():m.start()+80]!r}")
    if failures:
        print("FAIL"); [print(" -", f) for f in failures]; return 1
    print(f"PASS: {len(REQUIRED_SECTIONS)} sections, {len(REQUIRED_COPY)} copy strings, "
          f"{len(FORBIDDEN_COPY)} forbidden strings absent, no external resources"); return 0

if __name__ == "__main__":
    sys.exit(main())
