import { ArrowRight, FlaskConical } from "lucide-react";
import { Link } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { reviewExplanation } from "./reviewCopy";

export function ReviewsPage() {
  usePageTitle("复盘");
  const workspace = useWorkspace();
  const resource = useResource((signal) => seoOpsApi.reviews({ merchant_id: workspace.merchantId, limit: 50 }, signal), [workspace.merchantId]);
  return <>
    <header className="page-heading"><div><span className="eyebrow">LEARNING LOOP / NO INVENTED ATTRIBUTION</span><h1>复盘与因果分析</h1><p>把“发生了什么”与“为什么发生”分开记录。</p></div><span className="scope-chip"><FlaskConical size={14} /> {workspace.merchant?.display_name ?? "全部商户"}</span></header>
    {resource.loading ? <div className="page-state" role="status">正在读取复盘证据…</div> : null}
    {resource.error ? <div className="page-state is-error" role="alert">复盘数据读取失败。<button onClick={resource.reload}>重试</button></div> : null}
    <div className="review-list">{resource.data?.items.map((item) => {
      const headingId = `review-${item.task_id}-heading`;
      return <article aria-labelledby={headingId} className={`review-card review-${item.classification.toLocaleLowerCase()}`} key={item.task_id}>
      <header><div><span className="eyebrow">TASK {item.task_id}</span><h2 id={headingId}>{item.goal ?? "目标未记录"}</h2></div><span className={`classification is-${item.classification.toLocaleLowerCase()}`}>{item.classification}</span></header>
      <p className={`review-explanation${item.classification === "CORRELATIONAL" ? " is-association" : ""}`}>{item.classification === "CORRELATIONAL" ? <strong>关联观察，不代表因果</strong> : null}<span>{reviewExplanation(item.classification)}</span></p>
      <dl className="causal-chain">
        <ReviewCell label="基线" value={item.baseline} /><ReviewCell label="动作组合" value={item.action} /><ReviewCell label="观察变化" value={item.observed_change} />
        <ReviewCell label="混杂因素" value={item.competing_explanations.join("、")} /><ReviewCell label="结论" value={`${item.classification} · ${item.conclusion_strength}`} /><ReviewCell label="下一轮计划输入" value={item.follow_up_test} />
      </dl>
      <footer><span>{item.evidence_ids.length} 条技术证据引用；引用本身不构成因果证明</span><Link className="text-button" to={`/tasks/${encodeURIComponent(item.task_id)}`}>查看任务与技术证据 <ArrowRight size={14} /></Link></footer>
    </article>;
    })}</div>
    {resource.data && !resource.data.items.length ? <div className="empty-state"><h2>暂无可复盘任务</h2><p>证据附加到任务后，系统会按事实、相关和因果就绪度分级。</p></div> : null}
  </>;
}

function ReviewCell({ label, value }: { label: string; value?: string }) {
  return <div><dt>{label}</dt><dd>{value || "数据不可用"}</dd></div>;
}
