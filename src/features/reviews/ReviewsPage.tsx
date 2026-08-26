import { ArrowRight, FlaskConical } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { reviewExplanation } from "./reviewCopy";

export function ReviewsPage() {
  usePageTitle("复盘");
  const navigate = useNavigate();
  const workspace = useWorkspace();
  const resource = useResource((signal) => seoOpsApi.reviews({ merchant_id: workspace.merchantId, limit: 50 }, signal), [workspace.merchantId]);
  return <>
    <header className="page-heading"><div><span className="eyebrow">LEARNING LOOP / NO INVENTED ATTRIBUTION</span><h1>复盘与因果分析</h1><p>把“发生了什么”与“为什么发生”分开记录。</p></div><span className="scope-chip"><FlaskConical size={14} /> {workspace.merchant?.display_name ?? "全部商户"}</span></header>
    {resource.loading ? <div className="page-state" role="status">正在读取复盘证据…</div> : null}
    {resource.error ? <div className="page-state is-error" role="alert">复盘数据读取失败。<button onClick={resource.reload}>重试</button></div> : null}
    <div className="review-list">{resource.data?.items.map((item) => <article className="review-card" key={item.task_id}>
      <header><div><span className="eyebrow">TASK {item.task_id}</span><h2>{item.goal ?? "目标未记录"}</h2></div><span className={`classification is-${item.classification.toLocaleLowerCase()}`}>{item.classification}</span></header>
      <p className="review-explanation">{reviewExplanation(item.classification)}</p>
      <div className="causal-chain">
        <ReviewCell label="目标" value={item.goal} /><ReviewCell label="基线" value={item.baseline} /><ReviewCell label="动作" value={item.action} /><ReviewCell label="观察变化" value={item.observed_change} />
        <ReviewCell label="竞争解释" value={item.competing_explanations.join("、")} /><ReviewCell label="结论强度" value={item.conclusion_strength} /><ReviewCell label="下一次验证" value={item.follow_up_test} />
      </div>
      <footer><span>{item.evidence_ids.length} 条已引用证据</span><button className="text-button" onClick={() => navigate(`/tasks/${item.task_id}`)} type="button">查看任务 <ArrowRight size={14} /></button></footer>
    </article>)}</div>
    {resource.data && !resource.data.items.length ? <div className="empty-state"><h2>暂无可复盘任务</h2><p>证据附加到任务后，系统会按事实、相关和因果就绪度分级。</p></div> : null}
  </>;
}

function ReviewCell({ label, value }: { label: string; value?: string }) {
  return <div><span>{label}</span><p>{value || "数据不可用"}</p></div>;
}
