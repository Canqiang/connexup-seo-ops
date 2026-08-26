import { Bot, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { AgentBindingWire } from "../../api/types";
import { seoOpsApi } from "../../api/seoOpsApi";
import { formatDateOnly } from "../../app/format";
import { useResource } from "../../hooks/useResource";

export function AgentBindingsPanel({ canManage }: { canManage: boolean }) {
  const resource = useResource((signal) => seoOpsApi.agentBindings(signal), []);
  const [edits, setEdits] = useState<Record<string, { agent_id: string; agent_label: string }>>({});
  const [saving, setSaving] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const bindings = new Map<string, AgentBindingWire>((resource.data?.items ?? []).map((binding) => [binding.task_type, binding]));
  const keys = resource.data?.binding_keys ?? [];

  const save = async (key: string) => {
    const edit = edits[key];
    if (!canManage || !edit?.agent_id.trim()) return;
    setSaving(key);
    setSaveError(undefined);
    try {
      await seoOpsApi.upsertAgentBinding(key, {
        agent_id: edit.agent_id.trim(),
        agent_label: edit.agent_label.trim() || null,
      });
      setEdits((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      resource.reload();
    } catch (reason) {
      setSaveError(`${key} 保存失败：${reason instanceof Error ? reason.message : "请求失败"}`);
    } finally {
      setSaving(undefined);
    }
  };

  return <section aria-labelledby="agent-bindings-heading" className="settings-section data-panel">
    <div className="panel-heading"><div><span className="eyebrow">AGENT BINDINGS</span><h2 id="agent-bindings-heading"><Bot size={15} /> Agent 绑定</h2><p className="quiet-copy">任务派发按类型读取已发布 Agent 绑定；缺少绑定时，非人工建议不能被采纳。</p></div>
      <button aria-label="刷新绑定" className="icon-button" onClick={resource.reload} type="button"><RefreshCw size={15} /></button></div>
    {!canManage ? <p className="settings-readonly">当前账号可查看绑定，但没有修改权限。</p> : null}
    {saveError ? <p className="form-error" role="alert">{saveError}</p> : null}
    {resource.error ? <div className="page-state compact is-error" role="alert">Agent 绑定读取失败。<button onClick={resource.reload} type="button">重试</button></div> : null}
    {resource.loading ? <div className="page-state compact" role="status">读取绑定…</div> : null}
    {!resource.loading && !resource.error ? <div className="table-wrap"><table><thead><tr><th>绑定键</th><th>Agent ID（Core AI published）</th><th>备注</th><th>更新</th><th /></tr></thead><tbody>
      {keys.map((key) => {
        const bound = bindings.get(key);
        const edit = edits[key] ?? { agent_id: bound?.agent_id ?? "", agent_label: bound?.agent_label ?? "" };
        const dirty = edit.agent_id !== (bound?.agent_id ?? "") || edit.agent_label !== (bound?.agent_label ?? "");
        return <tr key={key}>
          <td><code>{key}</code>{bound ? null : <small className="danger-text">未绑定</small>}</td>
          <td><input aria-label={`${key} Agent ID`} className="inline-input" disabled={!canManage} onChange={(event) => setEdits((current) => ({ ...current, [key]: { ...edit, agent_id: event.target.value } }))} placeholder="agent uuid" value={edit.agent_id} /></td>
          <td><input aria-label={`${key} Agent 备注`} className="inline-input" disabled={!canManage} onChange={(event) => setEdits((current) => ({ ...current, [key]: { ...edit, agent_label: event.target.value } }))} placeholder="标签" value={edit.agent_label} /></td>
          <td>{bound ? formatDateOnly(bound.updated_at) : "—"}</td>
          <td><button className="secondary-button" disabled={!canManage || !dirty || saving === key} onClick={() => void save(key)} type="button">{saving === key ? "…" : "保存"}</button></td>
        </tr>;
      })}
      {!keys.length ? <tr><td colSpan={5}>后端未返回可绑定的任务类型。</td></tr> : null}
    </tbody></table></div> : null}
  </section>;
}
