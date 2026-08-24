import { CalendarClock, CheckCircle2, CircleDot, LockKeyhole, X } from "lucide-react";
import { taskStatusView, type DemoTask } from "./demoTasks";
import { formatTaskOwner } from "./taskOwner";

export function DemoTaskDrawer({ task, onClose }: { task: DemoTask; onClose: () => void }) {
  const statusView = taskStatusView(task);
  return <div className="drawer-layer">
    <button aria-label="关闭演示任务详情" className="drawer-backdrop" onClick={onClose} type="button" />
    <aside aria-label="演示任务详情" aria-modal="true" className="task-drawer demo-task-drawer" role="dialog">
      <header className="drawer-header">
        <div><span className="eyebrow">FRONTEND DEMO / {task.task_type}</span><h2>{task.title}</h2></div>
        <button aria-label="关闭" className="icon-button" onClick={onClose} type="button"><X size={18} /></button>
      </header>
      <div className="demo-task-body">
        <div className="demo-boundary"><LockKeyhole size={15} /><span>前端演示数据，不会写入后端或触发 Core AI。</span></div>

        <section className="demo-task-summary">
          <div><span>商户 / 地点</span><strong>{task.merchant_name}</strong><small>{task.location_name ?? "商户级"}</small></div>
          <div><span>周期</span><strong>{task.cadence}</strong><small>{task.trigger}</small></div>
          <div><span>当前状态</span><strong><i className={`status-pill is-${statusView.className}`}>{statusView.label}</i></strong><small>{task.evidence_state} EVIDENCE</small></div>
          <div><span>下一步</span><strong>{task.next_step}</strong><small>{formatTaskOwner(task.owner_id)}</small></div>
        </section>

        <section className="demo-task-section">
          <span className="eyebrow">OBJECTIVE</span>
          <h3>任务目标</h3>
          <p>{task.objective}</p>
        </section>

        {task.post_occurrence ? <PostOccurrence task={task} /> : null}

        <section className="demo-task-section">
          <span className="eyebrow">INPUT → OUTPUT</span>
          <h3>输入与交付物</h3>
          <ul>{task.inputs.map((input) => <li key={input}><CircleDot size={12} /> {input}</li>)}</ul>
          <div className="demo-deliverable"><strong>交付物</strong><span>{task.deliverable}</span></div>
        </section>

        <section className="demo-task-section">
          <span className="eyebrow">ACCEPTANCE</span>
          <h3>完成标准</h3>
          <ul>{task.success_criteria.map((criterion) => <li key={criterion}><CheckCircle2 size={12} /> {criterion}</li>)}</ul>
        </section>

        <section className="demo-task-section">
          <span className="eyebrow">DEPENDENCIES</span>
          <h3>依赖关系</h3>
          <div className="demo-dependencies">{task.dependencies.length
            ? task.dependencies.map((dependency) => <span key={dependency}>{dependency}</span>)
            : <span className="is-clear">无前置阻塞</span>}
          </div>
        </section>

        <div className="demo-task-actions"><span>仅用于本次产品 Demo</span><button className="primary-button" disabled type="button">演示模式 · 不执行</button></div>
      </div>
    </aside>
  </div>;
}

function PostOccurrence({ task }: { task: DemoTask }) {
  const item = task.post_occurrence;
  if (!item) return null;
  return <section className="demo-task-section demo-post-brief">
    <div className="demo-calendar-heading">
      <div><span className="eyebrow">GBP POST INSTANCE</span><h3>本次发布 Brief</h3></div>
      <span><CalendarClock size={13} /> {formatPublishTime(item.publish_at)}</span>
    </div>
    <p className="demo-keyword-rule">一篇 Post 只使用一个主要搜索意图 / 关键词簇。</p>
    <div className="demo-post-brief-grid">
      <div><span>主题 / 意图</span><strong>{item.topic}</strong><small>{item.intent}</small></div>
      <div><span>发布状态</span><strong><i className={`calendar-status is-${item.status}`}>{item.status}</i></strong><small>{task.status}</small></div>
      <div className="span-two"><span>主关键词簇</span><strong className="keyword-primary">{item.primary_keyword_cluster}</strong><small>本次 Post 的唯一主要搜索意图</small></div>
      <div className="span-two"><span>辅助词</span><div className="demo-keyword-tags">{item.supporting_keywords.map((keyword) => <i key={keyword}>{keyword}</i>)}</div></div>
      <div><span>CTA</span><strong>{item.cta}</strong></div>
      <div><span>负责人</span><strong>{formatTaskOwner(task.owner_id)}</strong></div>
    </div>
  </section>;
}

function formatPublishTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}
