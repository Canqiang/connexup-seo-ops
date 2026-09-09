#!/usr/bin/env python3
"""Acceptance check for the AM workspace prototype v4 (data workspace + interaction contract specs, prompt-v4.md)."""
from __future__ import annotations
import re, sys
from pathlib import Path

PROTO = Path(__file__).resolve().parent / "prototype"
REQUIRED_SECTIONS = [
    "am-home", "am-merchant-list", "am-task-list", "am-merchant-space",
    "am-audit-center", "am-audit-compare", "am-performance",
    "am-gbp-work-order", "am-exceptions", "am-task-detail-human",
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
    "已确认事实", "Core AI 原生记忆", "确认为规则",
    "模型与成本", "升级条件", "预算规则", "角色与模型不永久绑定",
    "记录交付", "冻结快照",
    # v3: principles, demo-data banner, rule ids and "why you"
    "Agent 主动推进，AM 按职责参与", "Plan 授权工作范围，内容审批授权具体产物", "系统用证据判断完成",
    "演示数据", "R3 · 公开内容需逐条审批", "R4 · Plan #12 付费扫描额度 100 credits", "本次 120",
    "已在 Plan #12 额度 100 内自动执行", "R1 · 在 Plan #12 允许的",
    # v3: work order de-duplication and approval binding
    "本次批准绑定", "发布时间窗",
    # v3: exceptions section
    "异常恢复", "退回 → 修改 → 新审核", "批准后产物变化 → 批准失效", "发布超时 → 自动核验 → 人工介入",
    "输入任务取消 → 下游重新规划", "批准已失效", "影响范围分级", "任务级", "商户级", "项目级",
    # v3: memory three classes, isolation as precondition, hypothesis validation
    "经营事实", "业务规则与偏好", "候选经验", "未启用 · 隔离未验证", "待数据验证", "确认偏好适用，不等于证明策略有效",
    # v3: model by stage, cost three states
    "工作阶段", "确定性程序", "已消耗", "已预留", "未结算", "缺事实、缺权限不允许升级",
    # v3: reports three layers, labelled draft export, coverage checklist
    "冻结报告", "草稿 · 未审核", "旧报告覆盖清单", "未覆盖",
    # v4: cleanup
    "由 Orchestrator 重新规划", "总分 47", "284 ÷ 6 = 47.3", "最新补充观测",
    # v4: merchant tabs and overview
    "资料与记忆", "最近一次有效 Audit", "下次诊断",
    # v4: audit center
    "Audit 是周期任务 + 历史诊断", "查看最近诊断", "立即诊断", "周期设置", "执行失败", "保留上一次有效结果",
    "专项 · 不计总分", "首次入驻诊断", "Audit #29 正在执行", "修改后从下一次执行生效",
    # v4: audit compare
    "新增问题", "持续存在", "已核验解决", "再次出现", "可直接比较", "不每次重新派单",
    # v4: performance
    "选择期间只查询已有数据", "分析这段表现", "生成报告", "同步数据", "电话按钮点击 ≠ 接通或到店",
    "缺失 08-12 至 08-14", "历史扫描", "没扫描的日期不补成曲线", "两者不同是正常的", "上一等长期间",
    # v4: interaction contract
    "返回时恢复搜索、筛选、分页与滚动位置", "六种情况", "已入队", "不会自动重新提交", "内容已变化", "重新载入",
]
# Copy the v2 review explicitly removed; its presence means a flow fix regressed.
FORBIDDEN_COPY = ["批准并发布", "标记为无法完成", "应用提案", "Local Falcon 扫描将消耗 40 credits", "批准扫描", "会一直等待，需要重新派单"]
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
    # Compare on tag-stripped text with whitespace and middle dots removed, so a rule id rendered as
    # <code>R3</code>公开内容… still matches the prompt's "R3 · 公开内容…".
    norm = lambda s: re.sub(r"[\s·]+", "", re.sub(r"<[^>]+>", "", s))
    text_norm = norm(html)
    for text in REQUIRED_COPY:
        if norm(text) not in text_norm:
            failures.append(f"missing copy: {text}")
    for text in FORBIDDEN_COPY:
        if norm(text) in text_norm:
            failures.append(f"forbidden copy present: {text}")
    for m in EXTERNAL.finditer(html):
        failures.append(f"external resource: {html[m.start():m.start()+80]!r}")
    # Interaction contract (spec §12): every in-page anchor resolves, every button declares its target.
    ids = set(re.findall(r"""\bid\s*=\s*["']([^"']+)["']""", html))
    for href in re.findall(r"""href\s*=\s*["']#([^"']+)["']""", html):
        if href and href not in ids:
            failures.append(f"dangling anchor: #{href}")
    buttons = re.findall(r"<button\b[^>]*>", html, re.I)
    without_target = [b for b in buttons if "data-target" not in b]
    if without_target:
        failures.append(f"{len(without_target)} of {len(buttons)} <button> without data-target, e.g. {without_target[0][:100]!r}")
    if not re.search(r"""data-effect\s*=\s*["'](open|submit|expand|external|none)["']""", html):
        failures.append("no data-effect attributes found")
    if failures:
        print("FAIL"); [print(" -", f) for f in failures]; return 1
    print(f"PASS: {len(REQUIRED_SECTIONS)} sections, {len(REQUIRED_COPY)} copy strings, "
          f"{len(FORBIDDEN_COPY)} forbidden strings absent, anchors resolve, buttons carry data-target, no external resources"); return 0

if __name__ == "__main__":
    sys.exit(main())
