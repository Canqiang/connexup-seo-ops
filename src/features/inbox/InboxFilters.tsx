import type { MerchantSummary, SeoOpsPageRequest } from "../../api/types";

export function InboxFilters({ filters, merchant, onChange }: {
  filters: SeoOpsPageRequest;
  merchant?: MerchantSummary;
  onChange: (patch: Partial<SeoOpsPageRequest>) => void;
}) {
  return <div className="filters" aria-label="执行任务筛选">
    <label>状态<select value={filters.status ?? ""} onChange={(event) => onChange({ status: event.target.value, offset: 0 })}>
      <option value="">全部</option>
      <option value="NEEDS_INPUT">待输入</option><option value="BLOCKED">阻塞</option>
      <option value="READY_FOR_APPROVAL">待审批</option><option value="REVISION_REQUIRED">需修订</option>
      <option value="APPROVAL_REVOKED">批准已撤销</option><option value="APPROVED">已批准</option>
      <option value="DISPATCHING">派发在途</option><option value="OUTCOME_UNKNOWN">结果待查</option>
      <option value="PENDING_VERIFY">待核验</option><option value="DONE">已完成</option>
      <option value="FAILED">失败·升级人工</option>
    </select></label>
    <label>证据<select value={filters.evidence_state ?? ""} onChange={(event) => onChange({ evidence_state: event.target.value as SeoOpsPageRequest["evidence_state"], offset: 0 })}>
      <option value="">全部</option><option value="NONE">无</option><option value="PARTIAL">部分</option><option value="VERIFIED">齐备</option><option value="UNVERIFIABLE">无法核实</option>
    </select></label>
    {merchant ? <label>地点<select value={filters.location_id ?? ""} onChange={(event) => onChange({ location_id: event.target.value, offset: 0 })}>
      <option value="">全部地点</option>{merchant.locations.map((location) => <option key={location.id} value={location.id}>{location.display_name}</option>)}
    </select></label> : null}
    <label>负责人<select value={filters.owner_id ?? ""} onChange={(event) => onChange({ owner_id: event.target.value, offset: 0 })}>
      <option value="">全部负责人</option>{merchant?.operators.map((operator) => <option key={operator.id} value={operator.id}>{operator.name}</option>)}</select></label>
  </div>;
}
