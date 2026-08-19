import { Play, Square } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "../../api/client";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { AgentRunStatus, AgentRunView, TriggerAgentRunRequest } from "../../api/types";
import { useResource } from "../../hooks/useResource";

const DEFAULT_RUN_TYPES: TriggerAgentRunRequest["run_type"][] = [
  "AUDIT", "KEYWORD_RESEARCH", "PLAN", "REPORT", "REVIEW",
];

function isActive(status: AgentRunStatus): boolean {
  return status === "TRIGGERING" || status === "RUNNING";
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function tokenSummary(usage: Record<string, number>): string | null {
  const parts = Object.entries(usage ?? {}).map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function AgentRunsPanel({ taskId, canManage, onTaskChanged }: {
  taskId: string;
  canManage: boolean;
  onTaskChanged: () => void;
}) {
  const configResource = useResource((signal) => seoOpsApi.config(signal), []);
  const runsResource = useResource(
    (signal) => seoOpsApi.agentRuns(taskId, { limit: 50 }, signal),
    [taskId],
  );
  const [runType, setRunType] = useState<TriggerAgentRunRequest["run_type"]>("AUDIT");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [fullOutputs, setFullOutputs] = useState<Record<string, string | null>>({});

  const enabled = configResource.data?.agent_run_enabled === true;
  const runTypes = configResource.data?.agent_run_types ?? DEFAULT_RUN_TYPES;
  const runs = runsResource.data?.items ?? [];
  const activeCount = runs.filter((run) => isActive(run.status)).length;

  // Poll while runs are active; when the last one turns terminal the task
  // aggregate (evidence / links / events) needs a refresh.
  const prevActive = useRef(0);
  useEffect(() => {
    if (prevActive.current > 0 && activeCount === 0) onTaskChanged();
    prevActive.current = activeCount;
    if (activeCount === 0) return undefined;
    const timer = setInterval(() => { runsResource.reload(); }, 5000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCount]);

  const trigger = async (event: FormEvent) => {
    event.preventDefault(); setStatus("");
    setBusy(true);
    try {
      await seoOpsApi.triggerAgentRun(taskId, {
        run_type: runType,
        goal: goal.trim() === "" ? undefined : goal.trim(),
        idempotency_key: crypto.randomUUID(),
      });
      setGoal("");
      runsResource.reload();
    } catch (error) {
      setStatus(
        error instanceof ApiError && error.status === 503
          ? "后端未配置 core-ai（CORE_AI_* 环境变量缺失），无法触发 Agent Run。"
          : error instanceof ApiError && error.status === 502
            ? `触发失败：${error.message}`
            : "触发失败，请稍后重试。",
      );
    } finally { setBusy(false); }
  };

  const cancel = async (id: string) => {
    try { await seoOpsApi.cancelAgentRun(id); } catch { /* next poll refreshes */ }
    runsResource.reload();
  };

  // Lists only carry a 2000-char preview; fetch the full output on expand.
  const ensureFull = async (run: AgentRunView) => {
    if (run.output != null) return;
    if (fullOutputs[run.id] !== undefined) return;
    try {
      const detail = await seoOpsApi.agentRun(run.id);
      setFullOutputs((prev) => ({ ...prev, [run.id]: detail.output ?? null }));
    } catch {
      setFullOutputs((prev) => ({ ...prev, [run.id]: null }));
    }
  };

  const renderRun = (run: AgentRunView) => {
    const tokens = tokenSummary(run.token_usage);
    const output = run.output ?? fullOutputs[run.id] ?? run.output_preview;
    return <li className="run-item" key={run.id}>
      <div className="run-row">
        <strong>{run.run_type}</strong>
        <span className={`status-pill is-${run.status.toLowerCase()}`}>{run.status}</span>
        {run.core_status ? <code>{run.core_status}</code> : null}
        <small>{formatTime(run.created_at)}</small>
        {isActive(run.status) && canManage
          ? <button className="danger-button" onClick={() => cancel(run.id)} type="button"><Square size={12} /> 取消</button>
          : null}
      </div>
      <div className="run-meta">
        {run.goal ? <small>目标：{run.goal}</small> : null}
        {tokens ? <small>{tokens}</small> : null}
        {run.error ? <small className="danger-text">{run.error_code ?? "ERROR"}：{run.error}</small> : null}
        {run.evidence_skipped_reason ? <small>证据未追加：{run.evidence_skipped_reason}</small> : null}
      </div>
      {output ? (
        <details className="run-output" onToggle={(event) => { if (event.currentTarget.open) void ensureFull(run); }}>
          <summary>查看输出{run.artifact_sha256 ? `（${run.artifact_sha256.slice(0, 19)}…）` : ""}</summary>
          <pre>{output}</pre>
        </details>
      ) : null}
    </li>;
  };

  return <section className="data-panel" aria-label="Agent 运行">
    <div className="panel-heading">
      <div><span className="eyebrow">AGENT ORCHESTRATION</span><h2>Agent 运行（只读 SOP）</h2></div>
      <span className="result-count">{runsResource.data?.total ?? "—"}</span>
    </div>
    {canManage ? <form className="command-form" onSubmit={trigger}>
      <div className="form-grid">
        <label>运行类型
          <select onChange={(event) => setRunType(event.target.value as TriggerAgentRunRequest["run_type"])} value={runType}>
            {runTypes.map((type) => <option key={type}>{type}</option>)}
          </select>
        </label>
        <label className="span-two">操作员补充目标（可选）
          <textarea maxLength={2000} onChange={(event) => setGoal(event.target.value)} placeholder="例如：关注 SoLV 排名与地图包表现" rows={2} value={goal} />
        </label>
      </div>
      <div className="form-actions">
        <span role="status">{status}</span>
        <button className="primary-button" disabled={busy || !enabled} type="submit">
          <Play size={14} /> {busy ? "触发中…" : "触发 Agent Run"}
        </button>
      </div>
      {!enabled ? <p className="unavailable">只读 SOP 运行未启用：后端尚未配置 core-ai（CORE_AI_* 环境变量）。</p> : null}
    </form> : null}
    {runsResource.error
      ? <div className="page-state is-error" role="alert">Agent 运行记录读取失败。</div>
      : runsResource.loading && runs.length === 0
        ? <div className="page-state" role="status">读取运行…</div>
        : runs.length === 0
          ? <p className="unavailable">尚无 Agent 运行记录。触发一次只读 SOP（审计 / 关键词 / 规划 / 报告 / 复盘）后，产物将自动归档为 UNVERIFIED 证据。</p>
          : <ul className="run-list">{runs.map(renderRun)}</ul>}
  </section>;
}
