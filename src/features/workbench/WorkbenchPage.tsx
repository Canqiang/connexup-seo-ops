import { useSearchParams } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { HumanActionGroup } from "../../api/types";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useResource } from "../../hooks/useResource";
import { ActionQueue } from "./ActionQueue";
import { DecisionSummary } from "./DecisionSummary";

const groupValues = new Set<HumanActionGroup>(["GATEKEEPING", "EXCEPTION", "MERCHANT_CONTACT"]);

export function WorkbenchPage() {
  const [params, setParams] = useSearchParams();
  const selectedGroup = groupValues.has(params.get("group") as HumanActionGroup) ? params.get("group") as HumanActionGroup : undefined;
  const resource = useResource((signal) => seoOpsApi.workbench({ group: selectedGroup, limit: 50 }, signal), [selectedGroup]);
  usePageTitle("工作台");

  const selectGroup = (group?: HumanActionGroup) => {
    const next = new URLSearchParams(params);
    if (group) next.set("group", group);
    else next.delete("group");
    setParams(next);
  };

  return <>
    <header className="page-heading workbench-heading"><div><span className="eyebrow">OPERATOR WORKBENCH / 人工决策</span><h1>今天需要我处理</h1><p>这里只显示必须由人判断、确认或联络的事项；自动运行的工作不会伪装成待办。</p></div></header>
    {resource.data ? <DecisionSummary onSelect={selectGroup} selectedGroup={selectedGroup} summary={resource.data.summary} /> : null}
    {resource.loading ? <div className="page-state" role="status">正在读取人工决策队列…</div> : null}
    {resource.error ? <div className="page-state is-error" role="alert">工作台读取失败。<button onClick={resource.reload} type="button">重试</button></div> : null}
    {resource.data && resource.data.total === 0 ? <section className="workbench-empty"><h2>今天没有需要人工处理的事项</h2><p>下一次自动检查会按已配置的周期运行；出现需要人工决定的事项时，会在这里显示。</p></section> : null}
    {resource.data && resource.data.total > 0 ? <ActionQueue items={resource.data.items} /> : null}
  </>;
}
