import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { canonicalOffset, pageRecoveryOffset, visiblePageRange } from "../../app/pagination";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { HumanActionGroup } from "../../api/types";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useResource } from "../../hooks/useResource";
import { ActionQueue } from "./ActionQueue";
import { DecisionSummary } from "./DecisionSummary";

const groupValues = new Set<HumanActionGroup>(["GATEKEEPING", "EXCEPTION", "MERCHANT_CONTACT"]);
const pageSize = 50;

export function WorkbenchPage() {
  const [params, setParams] = useSearchParams();
  const selectedGroup = groupValues.has(params.get("group") as HumanActionGroup) ? params.get("group") as HumanActionGroup : undefined;
  const parsedOffset = canonicalOffset(params);
  const offset = parsedOffset.value;
  const paramsKey = params.toString();
  const resource = useResource((signal) => seoOpsApi.workbench({ group: selectedGroup, offset, limit: pageSize }, signal), [selectedGroup, offset]);
  usePageTitle("工作台");

  const page = resource.data;
  const recoveryOffset = page ? pageRecoveryOffset(page) : null;
  const correctingPage = recoveryOffset !== null && !resource.error;
  const range = page ? visiblePageRange(page) : null;
  useEffect(() => {
    if (!parsedOffset.needsNormalization) return;
    const next = new URLSearchParams(paramsKey);
    next.set("offset", "0");
    setParams(next, { replace: true });
  }, [paramsKey, parsedOffset.needsNormalization, setParams]);
  useEffect(() => {
    if (recoveryOffset === null || recoveryOffset === offset) return;
    const next = new URLSearchParams(paramsKey);
    next.set("offset", String(recoveryOffset));
    setParams(next, { replace: true });
  }, [offset, paramsKey, recoveryOffset, setParams]);

  const selectGroup = (group?: HumanActionGroup) => {
    const next = new URLSearchParams(params);
    if (group) next.set("group", group);
    else next.delete("group");
    next.set("offset", "0");
    setParams(next);
  };

  const selectPage = (nextOffset: number) => {
    const next = new URLSearchParams(params);
    next.set("offset", String(Math.max(0, nextOffset)));
    setParams(next);
  };
  return <>
    <header className="page-heading workbench-heading"><div><span className="eyebrow">OPERATOR WORKBENCH / 人工决策</span><h1>今天需要我处理</h1><p>这里只显示必须由人判断、确认或联络的事项；自动运行的工作不会伪装成待办。</p></div></header>
    {page && !resource.error ? <DecisionSummary onSelect={selectGroup} selectedGroup={selectedGroup} summary={page.summary} /> : null}
    {resource.loading && !correctingPage ? <div className="page-state" role="status">正在读取人工决策队列…</div> : null}
    {correctingPage ? <div className="page-state" role="status">正在校正分页…</div> : null}
    {resource.error ? <div className="page-state is-error" role="alert">工作台读取失败。<button onClick={resource.reload} type="button">重试</button></div> : null}
    {page && !resource.error && !correctingPage && page.total === 0 ? <section className="workbench-empty"><h2>今天没有需要人工处理的事项</h2><p>下一次自动检查会按已配置的周期运行；出现需要人工决定的事项时，会在这里显示。</p></section> : null}
    {page && !resource.error && !correctingPage && page.total > 0 && !range ? <div className="page-state" role="status">当前页未返回人工事项，请重试。</div> : null}
    {page && !resource.error && !correctingPage && range ? <>
      <ActionQueue items={page.items} />
      <nav aria-label="工作台分页" className="workbench-pagination">
        <span aria-live="polite">显示 {range.start}–{range.end} / {page.total}</span>
        <div>
          <button disabled={page.offset === 0} onClick={() => selectPage(page.offset - page.limit)} type="button">上一页</button>
          <button disabled={page.offset + page.limit >= page.total} onClick={() => selectPage(page.offset + page.limit)} type="button">下一页</button>
        </div>
      </nav>
    </> : null}
  </>;
}
