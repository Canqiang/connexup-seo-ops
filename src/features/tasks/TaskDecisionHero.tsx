import type { ReactNode } from "react";
import type { SeoTask } from "../../api/types";
import type { TaskDecisionDescriptor } from "../../app/statusCopy";

/** 首屏只呈现一个人需要作出的决定；版本、哈希和运行轨迹留给审计详情。 */
export function TaskDecisionHero({ task, decision, children }: {
  task: SeoTask;
  decision: TaskDecisionDescriptor;
  children?: ReactNode;
}) {
  return <section aria-label="当前决策" className="task-decision-hero">
    <div className="task-decision-context"><span className="eyebrow"><span>{task.merchant_name}</span>{task.location_name ? <> · <span>{task.location_name}</span></> : null}</span><h1>{task.title}</h1></div>
    <div className="task-decision-main"><span className="eyebrow">CURRENT HUMAN DECISION</span><h2>{decision.heading}</h2><p>{decision.consequence}</p></div>
    <section aria-label="当前内容" className="task-current-content"><span className="eyebrow">当前执行内容</span><pre>{task.execution_spec}</pre></section>
    <div className="task-decision-action">{children ?? (decision.actionLabel ? <button className="primary-button" type="button">{decision.actionLabel}</button> : <p className="quiet-copy">当前账号可查看该决定，但没有执行权限。</p>)}</div>
  </section>;
}
