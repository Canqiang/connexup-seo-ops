import { ArrowRight, CheckCircle2, CircleAlert, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import { requestJson } from "../../api/client";
import type {
  AgentRunStage, DeliverableWire, LatestRunWire, LifecycleStageWire, LifecycleView, LocationSummary,
  RankingOverviewView, RankingRowWire, StageRunView, TaskSummary,
} from "../../api/types";
import { hasPermission } from "../../auth/permissions";
import { useAuth } from "../../auth/AuthContext";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { DemoTaskDrawer } from "../inbox/DemoTaskDrawer";
import { buildDemoTasks, isDemoTask, taskStatusView, type DemoTask } from "../inbox/demoTasks";
import { reviewExplanation } from "../reviews/reviewCopy";
import { STAGE_LABELS } from "./lifecycleCopy";
import { parsePlanItems, planItemExecutionSpec, type PlanItem } from "./planItems";

type CurrentQuestionnaire = NonNullable<LifecycleView["questionnaire"]>;
/** 可一键触发 agent 的阶段（EXECUTE/VERIFY 人工环节，永不可触发）。 */
type TriggerableStage = "KEYWORDS" | "AUDIT" | "RANKING_BASELINE" | "PLAN";
/** 阶段卡的上一阶段（产物提示用；KEYWORDS 起点无上游）。 */
const PRIOR_STAGE: Record<TriggerableStage, TriggerableStage | null> = {
  KEYWORDS: null,
  AUDIT: "KEYWORDS",
  RANKING_BASELINE: "AUDIT",
  PLAN: "RANKING_BASELINE",
};

/** 商户生命周期页：一条阶段轨（问卷→关键词→双审计→排名基线→Plan→执行→核验）。
 * 阶段卡就地完成 触发→运行→附件交付 闭环，不跳任务页；只有 Plan 确认才产生 task。 */
export function MerchantWorkspacePage() {
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [selectedDemoTask, setSelectedDemoTask] = useState<DemoTask>();
  const merchant = workspace.merchant;
  const merchantId = workspace.merchantId ?? useParams<{ merchantId: string }>().merchantId ?? "";
  const lifecycle = useResource((signal) => seoOpsApi.lifecycle(merchantId, signal), [merchantId]);
  const ranking = useResource((signal) => seoOpsApi.ranking(merchantId, signal), [merchantId]);
  const tasks = useResource((signal) => seoOpsApi.inbox({ merchant_id: merchantId, limit: 8 }, signal), [merchantId]);
  const reviews = useResource((signal) => seoOpsApi.reviews({ merchant_id: merchantId, limit: 3 }, signal), [merchantId]);
  const reports = useResource((signal) => seoOpsApi.reports({ merchant_id: merchantId, limit: 3 }, signal), [merchantId]);
  const demoTaskPreview = useMemo(() => buildDemoTasks(workspace.merchants)
    .filter((task) => task.merchant_id === merchantId)
    .sort((left, right) => Date.parse(left.due_at ?? "") - Date.parse(right.due_at ?? ""))
    .slice(0, 4), [merchantId, workspace.merchants]);

  if (workspace.loading) return <div className="page-state" role="status">正在读取商户…</div>;
  if (!merchant) return <div className="page-state is-error" role="alert">商户不存在或当前用户不可见。</div>;

  const data = lifecycle.data;
  const canManage = hasPermission(user?.permissions, "seoops.manage");
  const useDemoTaskPreview = Boolean(tasks.data && tasks.data.items.length === 0);
  const taskPreview = useDemoTaskPreview ? demoTaskPreview : (tasks.data?.items ?? []).slice(0, 4);
  const onboarding = Boolean(merchant.stage && merchant.stage !== "EXECUTE" && merchant.stage !== "VERIFY");
  const openTaskPreview = (task: typeof taskPreview[number]) => {
    if (isDemoTask(task)) setSelectedDemoTask(task);
    else navigate(`/tasks/${task.id}`);
  };
  // 当前阶段若是可触发阶段：卡片自带触发热键（RANKING_BASELINE 复查到期也会落在这里）
  const triggerable: TriggerableStage | null =
    data?.stage === "KEYWORDS" || data?.stage === "AUDIT" || data?.stage === "RANKING_BASELINE"
      ? data.stage
      : data?.stage === "PLAN" && !data.latest_runs.PLAN
        ? "PLAN"
        : null;

  return <>
    <header className="page-heading">
      <div>
        <button className="text-button" onClick={() => navigate("/")} type="button">‹ 商户</button>
        <span className="eyebrow" style={{ display: "block", marginTop: 6 }}>MERCHANT / {merchant.slug}</span>
        <h1>{merchant.display_name}</h1>
        <p>
          {merchant.locations.map((l) => l.display_name).join("、") || "未建地点"}
          {data ? <> · <span className="round-badge">{roundBadgeLabel(data)}</span></> : null}
          {" "}· 阶段由交付物推导，任一环节重跑会自动回退
        </p>
      </div>
      <span className={`status-pill is-${onboarding ? "onboarding" : merchant.health.toLocaleLowerCase()}`}>{onboarding ? "接入中" : merchant.health}</span>
    </header>

    {lifecycle.error ? <div className="page-state is-error" role="alert">生命周期读取失败。<button onClick={lifecycle.reload}>重试</button></div> : null}
    {lifecycle.loading && !data ? <div className="page-state" role="status">推导阶段…</div> : null}

    {data ? <>
      <StageRail stages={data.stages} />

      {data.stage === "QUESTIONNAIRE"
        ? <QuestionnaireCard canManage={canManage} merchantId={merchant.id} questionnaire={data.questionnaire} reload={lifecycle.reload} />
        : null}

      {triggerable ? (
        <StageRunCard
          canManage={canManage}
          locations={merchant.locations}
          merchantId={merchant.id}
          priorDone={PRIOR_STAGE[triggerable] ? data.latest_runs[PRIOR_STAGE[triggerable]!] ?? null : null}
          reload={lifecycle.reload}
          stage={triggerable}
        />
      ) : null}

      {data.stage === "PLAN" && data.latest_runs.PLAN && !data.plan_converted
        ? <PlanConfirmCard lifecycleReload={lifecycle.reload} merchantId={merchant.id} planRun={data.latest_runs.PLAN} />
        : null}

      {(data.stage === "EXECUTE" || data.stage === "VERIFY") && tasks.data ? (
        <WorkOrderCard merchantId={merchant.id} tasks={tasks.data.items} unverifiedCount={data.unverified_evidence_count} />
      ) : null}

      {data.last_report ? <div className="compare-strip">
        <article><span>上次效果报告</span><strong>{data.last_report.age_days} 天前</strong><small className={data.last_report.age_days > 7 ? "" : "is-flat"}>{data.last_report.age_days > 7 ? "已过 7 天复查周期" : "复查周期内"}</small></article>
        <article><span>待审批任务</span><strong>{data.ready_for_approval_count}</strong><small className="is-flat">批准只记录授权</small></article>
        <article><span>待核验证据</span><strong>{data.unverified_evidence_count}</strong><small className={data.unverified_evidence_count > 0 ? "" : "is-flat"}>{data.unverified_evidence_count > 0 ? "执行回填后等核验" : "无"}</small></article>
      </div> : null}

      <RankingSection overview={ranking.data ?? null} />
    </> : null}

    <div className="workspace-grid">
      <section className="data-panel span-two"><div className="panel-heading"><div><span className="eyebrow">ACTION QUEUE · NEXT ACTIONS</span><div className="task-panel-title"><h2>任务</h2>{useDemoTaskPreview ? <span>FRONTEND DEMO · 最近 4 项</span> : <span>最近 {taskPreview.length} 项</span>}</div></div><Link className="text-button" to={`/inbox?merchant_id=${merchant.id}`}>全部任务 <ArrowRight size={14} /></Link></div>
        {tasks.loading ? <div className="page-state" role="status">读取任务…</div> : <div className="merchant-task-list">{taskPreview.map((task) => {
          const due = compactDue(task.due_at);
          const statusView = taskStatusView(task);
          return <button aria-label={`${isDemoTask(task) ? "打开任务摘要" : "打开任务"} ${task.title}`} className={isDemoTask(task) ? "is-demo" : undefined} onClick={() => openTaskPreview(task)} type="button" key={task.id}>
            <time dateTime={task.due_at}><strong>{due.date}</strong><small>{due.time}</small></time>
            <span className="merchant-task-copy"><strong>{task.title}</strong><small>{taskPreviewMeta(task)}</small></span>
            <span className="merchant-task-state"><span className={`priority-tag is-${task.priority.toLocaleLowerCase()}`}>{task.priority}</span><span className={`status-pill is-${statusView.className}`}>{statusView.label}</span></span>
            <ArrowRight aria-hidden size={15} />
          </button>;
        })}</div>}
      </section>
      <section className="data-panel"><div className="panel-heading"><div><span className="eyebrow">CAUSAL REVIEW</span><h2>复盘信号</h2></div><Link className="text-button" to={`/reviews?merchant_id=${merchant.id}`}>查看全部</Link></div><div className="mini-cards">{reviews.data?.items.map((item) => <article key={item.task_id}><span className={`classification is-${item.classification.toLocaleLowerCase()}`}>{item.classification}</span><strong>{item.goal ?? "目标未记录"}</strong><p>{reviewExplanation(item.classification)}</p></article>)}{reviews.data && !reviews.data.items.length ? <p className="unavailable">暂无可复盘数据</p> : null}</div></section>
      <section className="data-panel"><div className="panel-heading"><div><span className="eyebrow">REPORT FRESHNESS</span><h2>报告与数据</h2></div><Link className="text-button" to={`/reports?merchant_id=${merchant.id}`}>查看全部</Link></div><div className="mini-cards">{reports.data?.items.map((item) => <article key={item.report_id}><span className={`freshness is-${item.freshness.toLocaleLowerCase()}`}>{item.freshness}</span><strong>{item.title ?? item.report_type}</strong><p>{item.source_type === "CORE_AI_ARTIFACT" ? "Core AI 附件" : "任务证据"} · {new Date(item.captured_at).toLocaleString("zh-CN")}</p>{item.source_ref ? <a className="text-button" href={item.source_ref} rel="noreferrer" target="_blank">打开报告 ↗</a> : null}</article>)}{reports.data && !reports.data.items.length ? <p className="unavailable">暂无报告证据</p> : null}</div></section>
    </div>
    {selectedDemoTask ? <DemoTaskDrawer onClose={() => setSelectedDemoTask(undefined)} task={selectedDemoTask} /> : null}
  </>;
}

function compactDue(value?: string): { date: string; time: string } {
  if (!value) return { date: "待排期", time: "—" };
  const date = new Date(value);
  return {
    date: `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`,
    time: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
  };
}

function taskPreviewMeta(task: TaskSummary | DemoTask): string {
  if (isDemoTask(task) && task.post_occurrence) return task.post_occurrence.primary_keyword_cluster;
  if (isDemoTask(task)) return `${task.task_type} · ${task.cadence}`;
  return `${task.location_name ?? "商户级"} · ${task.task_type}`;
}

/** 轮次徽标：轮次 = 排名快照期数（首轮基线 + 每次复查）；月份取最新基线所在月。 */
function roundBadgeLabel(data: LifecycleView): string {
  if (data.ranking_round_count <= 1) return "⟳ 首轮接入";
  const month = data.last_report ? new Date(data.last_report.captured_at).getMonth() + 1 : null;
  return `⟳ 第 ${data.ranking_round_count} 轮${month !== null ? ` · ${month} 月` : ""}`;
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-CN");
}

function rankCell(rank: number | null): string {
  return rank === null ? "—" : String(rank);
}

/** 位次变化：正数 = 上升（更靠前）。 */
function deltaCell(delta: number | null): string {
  if (delta === null) return "—";
  if (delta > 0) return `▲ ${delta}`;
  if (delta < 0) return `▼ ${Math.abs(delta)}`;
  return "持平";
}

/** 与上期对比（只放数字，不做图表）+ 排名快照表——老店稳态与新店共用同一骨架，
 * 不足两期时只出快照表，没有快照就整段不渲染。 */
function RankingSection({ overview }: { overview: RankingOverviewView | null }) {
  if (!overview?.latest) return null;
  const { latest, previous, comparison } = overview;
  return <>
    {comparison && previous ? <div className="compare-strip">
      <article>
        <span>LOCAL 包内均值（{comparison.organic_top10.total} 词）</span>
        <strong>{comparison.local_avg.previous ?? "—"} → {comparison.local_avg.current ?? "—"}</strong>
        <small className={comparison.local_avg.delta ? "" : "is-flat"}>{
          comparison.local_avg.delta === null ? `对比口径不足 · 上期 ${dateLabel(previous.captured_at)}`
            : comparison.local_avg.delta > 0 ? `▲ 上升 ${comparison.local_avg.delta} 位 · 较上期 ${dateLabel(previous.captured_at)}`
              : comparison.local_avg.delta < 0 ? `▼ 下降 ${Math.abs(comparison.local_avg.delta)} 位 · 较上期 ${dateLabel(previous.captured_at)}`
                : `— 持平 · 较上期 ${dateLabel(previous.captured_at)}`
        }</small>
      </article>
      <article>
        <span>ORGANIC 首页词占比</span>
        <strong>{comparison.organic_top10.current} / {comparison.organic_top10.total}</strong>
        <small className={comparison.organic_top10.current === comparison.organic_top10.previous ? "is-flat" : ""}>{
          comparison.organic_top10.current > comparison.organic_top10.previous
            ? `▲ 较上期 +${comparison.organic_top10.current - comparison.organic_top10.previous}`
            : comparison.organic_top10.current < comparison.organic_top10.previous
              ? `▼ 较上期 ${comparison.organic_top10.current - comparison.organic_top10.previous}`
              : "— 持平 · 较上期"
        }</small>
      </article>
      <article>
        <span>新挖机会词</span>
        <strong>{comparison.new_keyword_count}</strong>
        <small className={comparison.new_keyword_count > 0 ? "" : "is-flat"}>{comparison.new_keyword_count > 0 ? "本期新出现 · 可并入下轮 Plan" : "无"}</small>
      </article>
    </div> : null}

    <section className="data-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">RANKING · local + organic</span><h2>排名快照 · {dateLabel(latest.captured_at)}</h2></div>
        <span className="result-count">{latest.keyword_count} 词{previous ? ` · 上期 ${dateLabel(previous.captured_at)}` : ""}</span>
      </div>
      <div className="ranking-table-scroll">
        <table className="ranking-table">
          <thead><tr><th>词</th><th>LOCAL</th><th>ORGANIC</th><th>LOCAL 较上期</th><th>ORGANIC 较上期</th></tr></thead>
          <tbody>
            {latest.rows.map((row: RankingRowWire) => <tr key={row.keyword}>
              <td>{row.keyword}{row.is_new ? <em className="new-keyword-tag">新词</em> : null}</td>
              <td>{rankCell(row.local_rank)}</td>
              <td>{rankCell(row.organic_rank)}</td>
              <td className={row.local_delta !== null && row.local_delta < 0 ? "is-down" : undefined}>{deltaCell(row.local_delta)}</td>
              <td className={row.organic_delta !== null && row.organic_delta < 0 ? "is-down" : undefined}>{deltaCell(row.organic_delta)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>
  </>;
}

function StageRail({ stages }: { stages: LifecycleStageWire[] }) {
  return <section aria-label="生命周期阶段" className="lifecycle-rail">
    {stages.map((stage) => (
      <div className={`r-step is-${stage.status === "CURRENT" ? "now" : stage.status === "DONE" ? "done" : "off"}`} key={stage.key}>
        <strong>{STAGE_LABELS[stage.key]}</strong>
        <small>{stage.note}</small>
      </div>
    ))}
  </section>;
}

/** 问卷阶段卡：等待商家回复是一等公民（第二用户面）。 */
function QuestionnaireCard({ questionnaire, reload, canManage, merchantId }: {
  questionnaire: CurrentQuestionnaire | null;
  reload: () => void;
  canManage: boolean;
  merchantId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async () => {
    if (!questionnaire) return;
    setBusy(true);
    setError("");
    try {
      await seoOpsApi.sendQuestionnaire(questionnaire.id);
      reload();
    } catch {
      setError("发放登记失败，稍后重试。");
    } finally {
      setBusy(false);
    }
  };
  const generate = async () => {
    setBusy(true);
    setError("");
    try {
      await seoOpsApi.createQuestionnaire(merchantId, { idempotency_key: `m-page-${crypto.randomUUID()}` });
      reload();
    } catch {
      setError("问卷生成失败，稍后重试。");
    } finally {
      setBusy(false);
    }
  };
  const publicUrl = questionnaire ? `${window.location.origin}/q/${questionnaire.share_slug}` : "";
  return <section className="cur-card">
    <span className="eyebrow">CURRENT STEP · 问卷</span>
    <h3>{questionnaire
      ? questionnaire.status === "SENT" ? "等待商家回复" : "问卷已生成，尚未发放"
      : "尚未生成接入问卷"}</h3>
    {questionnaire ? <p className="desc">
      {questionnaire.status === "SENT"
        ? <>外发链接已发出（{questionnaire.send_count > 1 ? `已重发 ${questionnaire.send_count - 1} 次，` : ""}最近一次 {questionnaire.last_sent_at ? new Date(questionnaire.last_sent_at).toLocaleDateString("zh-CN") : "—"}）。商家填完前，关键词及其后所有阶段都不会开始。</>
        : "把问卷链接发给商家后点「登记发放」；系统只登记外发事实，发送渠道（短信/邮件）在系统外。"}
    </p> : <p className="desc">在首页「＋ 新店」完成接入：店名/官网 → 生成问卷 → 发放。</p>}
    {questionnaire ? <div className="link-out">
      <span>{publicUrl}</span>
      <button className="text-button" onClick={() => { void navigator.clipboard?.writeText(publicUrl); }} type="button">复制</button>
    </div> : null}
    <div className="cur-actions">
      {canManage && !questionnaire ? <button className="primary-button" disabled={busy} onClick={() => { void generate(); }} type="button">{busy ? "生成中…" : "生成接入问卷"}</button> : null}
      {canManage && questionnaire ? <button className="primary-button" disabled={busy} onClick={() => { void send(); }} type="button"><RefreshCw size={13} /> {busy ? "登记中…" : questionnaire.status === "SENT" ? "重发问卷" : "登记发放"}</button> : null}
      {questionnaire ? <a className="text-button" href={publicUrl} rel="noreferrer" target="_blank">预览问卷 ›</a> : null}
      {error ? <span className="form-message" role="alert">{error}</span> : null}
    </div>
  </section>;
}

const STAGE_COPY: Record<TriggerableStage, { title: string; hint: string; action: string }> = {
  KEYWORDS: { title: "关键词调研", hint: "基于已回收的问卷生成关键词库，作为后续审计与排名的词表。", action: "生成关键词" },
  AUDIT: { title: "双审计（GBP + 站内）", hint: "对 GBP 与官网页做现状审计，问题清单与依据以附件归档。", action: "跑双审计" },
  RANKING_BASELINE: { title: "排名基线（local + organic）", hint: "建立 local/organic 排名基线，此后每周复查对比。", action: "建排名基线" },
  PLAN: { title: "优化 Plan 生成", hint: "基于审计与基线生成优化 Plan（建议清单附件），确认后逐条转任务。", action: "生成 Plan" },
};

/** 活跃运行（触发中/运行中）——就地处 5s 轮询直到终态。 */
function isActive(run: StageRunView | null): run is StageRunView {
  return run?.status === "TRIGGERING" || run?.status === "RUNNING";
}

function formatSize(size: number | null): string {
  if (size === null) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTokens(usage: Record<string, number>): string {
  const total = Object.values(usage).reduce((sum, v) => sum + v, 0);
  return total > 0 ? `${total.toLocaleString()} tokens` : "—";
}

function formatElapsed(run: StageRunView): string {
  const from = Date.parse(run.triggered_at);
  const to = run.completed_at ? Date.parse(run.completed_at) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "—";
  const seconds = Math.round((to - from) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 阶段卡：就地完成 触发 → 运行（5s 轮询）→ 附件交付 闭环。
 * 附件是一等交付物——COMPLETED 且有附件即点亮阶段；正文不产出附件时可手工上传兜底。 */
function StageRunCard({ stage, merchantId, locations, priorDone, reload, canManage }: {
  stage: TriggerableStage;
  merchantId: string;
  locations: LocationSummary[];
  priorDone: LatestRunWire | null;
  reload: () => void;
  canManage: boolean;
}) {
  const configResource = useResource((signal) => seoOpsApi.config(signal), []);
  const [run, setRun] = useState<StageRunView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const copy = STAGE_COPY[stage];
  const agentEnabled = configResource.data?.agent_run_enabled === true;

  // 载入该阶段最近一次运行（可能是 RUNNING——接手就地轮询）
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void seoOpsApi.stageRuns(merchantId, { stage, limit: 1 })
      .then((page) => { if (!cancelled) { setRun(page.items[0] ?? null); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [merchantId, stage]);

  // 活跃运行就地轮询；转终态时刷新生命周期（阶段轨推进）
  useEffect(() => {
    if (!isActive(run)) return;
    const id = setInterval(() => {
      void seoOpsApi.stageRun(run.id)
        .then((fresh) => {
          setRun(fresh);
          if (!isActive(fresh)) reload();
        })
        .catch(() => { /* 瞬时失败下一轮再试 */ });
    }, 5000);
    return () => clearInterval(id);
  }, [run?.id, run?.status, reload]);

  const trigger = async () => {
    setBusy(true);
    setError("");
    try {
      const created = await seoOpsApi.triggerStageRun(merchantId, {
        stage,
        location_id: locationId || undefined,
        idempotency_key: `stage-${stage}-${crypto.randomUUID()}`,
      });
      setRun(created);
      reload();
    } catch (err) {
      setError(err instanceof Error ? `触发失败：${err.message}` : "触发失败，稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!run) return;
    setBusy(true);
    setError("");
    try {
      setRun(await seoOpsApi.cancelStageRun(run.id));
      reload();
    } catch (err) {
      setError(err instanceof Error ? `取消失败：${err.message}` : "取消失败。");
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    if (!run) return;
    setBusy(true);
    setError("");
    try {
      const deliverable = await seoOpsApi.uploadManualDeliverable(run.id, {
        file_name: file.name,
        content_type: file.type || undefined,
        content_base64: await fileToBase64(file),
      });
      setRun({ ...run, deliverables: [...run.deliverables, deliverable] });
      reload();
    } catch (err) {
      setError(err instanceof Error ? `上传失败：${err.message}` : "上传失败。");
    } finally {
      setBusy(false);
    }
  };

  const attachments = run?.deliverables.filter((d) => d.kind !== "SUMMARY") ?? [];
  const summary = run?.deliverables.find((d) => d.kind === "SUMMARY") ?? null;
  // COMPLETED 但没有任何附件：正文不算交付物——提示重跑或手工上传
  const missingAttachments = run?.status === "COMPLETED" && attachments.length === 0;

  return <section className="cur-card">
    <span className="eyebrow">CURRENT STEP · {STAGE_LABELS[stage]}</span>
    <h3>{copy.title}</h3>
    <p className="desc">{copy.hint}</p>
    {priorDone ? <p className="desc">上一阶段产物：<strong>{STAGE_LABELS[PRIOR_STAGE[stage]!]}</strong>（{new Date(priorDone.completed_at).toLocaleDateString("zh-CN")} · {priorDone.deliverable_count} 个附件）</p> : null}

    {run ? <div className="run-live">
      <div className="run-meta">
        <span className={`status-pill is-${run.status.toLocaleLowerCase()}`}>{run.status}</span>
        <span>{isActive(run) ? "已运行" : "耗时"} {formatElapsed(run)}</span>
        {run.completed_at ? <span>{new Date(run.completed_at).toLocaleString("zh-CN")}</span> : null}
        <span>{formatTokens(run.token_usage)}</span>
      </div>
      {run.status === "FAILED" || run.status === "CANCELLED" ? (
        <p className="form-message" role="alert">{run.status === "FAILED" ? `失败：${run.error ?? run.error_code ?? "未知原因"}` : "已取消——可重新触发。"}</p>
      ) : null}
      {attachments.length > 0 ? <ul className="run-attachments">
        {attachments.map((d) => (
          <li key={d.id}>
            <span className={`kind-tag is-${d.kind.toLocaleLowerCase()}`}>{d.kind === "MANUAL" ? "手工" : "附件"}</span>
            {d.downloaded
              ? <a href={d.download_path} download={d.file_name}>{d.file_name}</a>
              : <span>{d.file_name}{d.download_error ? ` · 下载失败：${d.download_error}` : " · 未落盘"}</span>}
            {d.core_url ? <a className="text-button" href={d.core_url} rel="noreferrer" target="_blank">在 core-ai 打开 ↗</a> : null}
            <small>{formatSize(d.size)} · {d.content_type ?? "未知类型"}</small>
          </li>
        ))}
      </ul> : null}
      {missingAttachments ? <p className="desc">运行完成但 agent 只回了正文、没产出附件——阶段不会点亮。可展开正文核对后手工上传，或重跑。</p> : null}
      {run.output_preview || run.output ? <details className="run-output">
        <summary>正文输出</summary>
        <pre>{run.output ?? run.output_preview}</pre>
      </details> : null}
      {summary ? <details className="run-output">
        <summary>摘要（SUMMARY）</summary>
        <pre>{summary.title ?? summary.file_name}</pre>
      </details> : null}
    </div> : loaded ? <p className="desc quiet-copy">该阶段还没有运行记录。</p> : <p className="desc">读取运行记录…</p>}

    <div className="cur-actions">
      {canManage && agentEnabled && !isActive(run) ? <button className="primary-button" disabled={busy} onClick={() => { void trigger(); }} type="button">
        {busy ? "触发中…" : run ? `重跑 · ${copy.action} ›` : `一键${copy.action} ›`}
      </button> : null}
      {canManage && agentEnabled && isActive(run) ? <button className="danger-button" disabled={busy} onClick={() => { void cancel(); }} type="button">取消运行</button> : null}
      {canManage && missingAttachments ? <label className="secondary-button upload-label">
        手工上传附件<input accept=".md,.markdown,.txt,.csv,.json,.pdf" disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); e.target.value = ""; }} type="file" />
      </label> : null}
      {locations.length > 1 ? <select aria-label="选择地点" className="location-select" onChange={(e) => setLocationId(e.target.value)} value={locationId}>
        {locations.map((l) => <option key={l.id} value={l.id}>{l.display_name}</option>)}
      </select> : null}
      <span className="quiet-copy">{agentEnabled
        ? "触发后卡片就地轮询（5s），附件落盘即点亮阶段"
        : "后端未配置 core-ai，无法触发 agent 运行"}</span>
      {error ? <span className="form-message" role="alert">{error}</span> : null}
    </div>
  </section>;
}

/** 拉 markdown/text 附件正文（Plan 建议清单可能在附件里而不在正文）。 */
async function deliverableText(deliverables: DeliverableWire[]): Promise<string> {
  const doc = deliverables.find((d) => {
    const type = (d.content_type ?? "").toLowerCase();
    return type.includes("markdown") || type.startsWith("text/");
  });
  if (!doc || !doc.downloaded) return "";
  try {
    const text = await requestJson<string>(doc.download_path);
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

/** Plan 待确认：解析建议清单 → 勾选 → 逐条转任务（source=PLAN，走审批）。全系统唯一产生 task 的入口。 */
function PlanConfirmCard({ planRun, merchantId, lifecycleReload }: {
  planRun: LatestRunWire;
  merchantId: string;
  lifecycleReload: () => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    void seoOpsApi.stageRun(planRun.run_id)
      .then(async (run) => {
        const text = run.output && run.output.trim() !== "" ? run.output : await deliverableText(run.deliverables);
        if (!cancelled) setSource(text || planRun.output_preview || "");
      })
      .catch(() => { if (!cancelled) setSource(planRun.output_preview ?? ""); });
    return () => { cancelled = true; };
  }, [planRun.run_id, planRun.output_preview]);

  const items = useMemo(() => parsePlanItems(source ?? ""), [source]);
  useEffect(() => {
    if (selected === null && items.length > 0) setSelected(new Set(items.map((item) => item.id)));
  }, [items, selected]);

  const chosen = items.filter((item) => selected?.has(item.id));
  const priorityOf = (item: PlanItem): "URGENT" | "HIGH" | "MEDIUM" =>
    item.priority === "P0" ? "URGENT" : item.priority === "P1" ? "HIGH" : "MEDIUM";

  const convert = async () => {
    if (chosen.length === 0) return;
    setBusy(true);
    setError("");
    let created = 0;
    try {
      for (const item of chosen) {
        await seoOpsApi.createTask({
          merchant_id: merchantId,
          definition: {
            title: item.title,
            task_type: "SEO_EXECUTION",
            source: "PLAN",
            priority: priorityOf(item),
            impact: "MEDIUM",
            execution_spec: JSON.stringify(planItemExecutionSpec(item, planRun.run_id)),
            required_evidence_types: ["AFTER_SCREENSHOT"],
          },
          idempotency_key: `plan-${planRun.run_id}-${item.id}`,
        });
        created += 1;
      }
      setDoneCount(created);
      lifecycleReload();
    } catch {
      setError(`转任务中断：已建 ${created}/${chosen.length}。重试不会重复建（幂等键保护），请再点一次。`);
    } finally {
      setBusy(false);
    }
  };

  return <section className="cur-card">
    <span className="eyebrow">CURRENT STEP · PLAN 待确认</span>
    <h3>优化 Plan 已生成 · 等你确认转任务</h3>
    <p className="desc">基于审计与排名基线生成（{new Date(planRun.completed_at).toLocaleDateString("zh-CN")} · {planRun.deliverable_count} 个附件）。勾选条目后转为执行任务——逐条走审批，批准只记录授权。</p>
    {source === null ? <p className="desc">读取完整报告…</p> : null}
    {source !== null && items.length === 0 ? <>
      <p className="desc">报告里没有解析到建议清单。可展开正文核对，按需手工建任务。</p>
      <details className="run-output"><summary>报告正文</summary><pre>{source}</pre></details>
    </> : null}
    {items.length > 0 ? <ul className="plan-list">
      {items.map((item) => (
        <li className={selected?.has(item.id) ? "" : "is-off"} key={item.id}>
          <input aria-label={`选择 ${item.title}`} checked={selected?.has(item.id) ?? false} onChange={() => {
            setSelected((prev) => {
              const next = new Set(prev ?? items.map((i) => i.id));
              if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
              return next;
            });
          }} type="checkbox" />
          <span className="n">{item.priority ?? "—"}</span>
          <p>{item.title}{item.detail ? <small>{item.detail}</small> : null}</p>
        </li>
      ))}
    </ul> : null}
    <div className="cur-actions">
      {doneCount > 0
        ? <span className="done-note"><CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> 已生成 {doneCount} 个任务（见下方任务列表），逐条审批后进入执行</span>
        : <button className="primary-button" disabled={busy || chosen.length === 0} onClick={() => { void convert(); }} type="button">{busy ? "转换中…" : `确认 Plan · 生成 ${chosen.length} 个任务`}</button>}
      {error ? <span className="form-message" role="alert">{error}</span> : null}
    </div>
  </section>;
}

/** 执行阶段 = 人工工单（EXECUTE 自动化关闭；审批授权后人工执行、回填证据）。 */
function WorkOrderCard({ tasks, unverifiedCount, merchantId }: {
  tasks: Array<{ id: string; title: string; status: string; task_revision: number }>;
  unverifiedCount: number;
  merchantId: string;
}) {
  const navigate = useNavigate();
  const approved = tasks.filter((t) => t.status === "APPROVED");
  const pending = tasks.filter((t) => t.status !== "APPROVED" && t.status !== "APPROVAL_REVOKED");
  return <section className="data-panel">
    <div className="panel-heading">
      <div><span className="eyebrow">EXECUTE · 人工工单</span><h2>执行 · {approved.length} 个已授权</h2></div>
      <Link className="text-button" to={`/inbox?merchant_id=${merchantId}`}>全部任务</Link>
    </div>
    <p className="work-note"><CircleAlert size={13} style={{ flexShrink: 0, marginTop: 2 }} /> 审批只记录授权，EXECUTE 自动化未开放——按工单人工执行，完成后在任务里回填证据（UNVERIFIED），再核验。当前待核验 {unverifiedCount} 项。</p>
    <ul className="work-list">
      {approved.map((task) => (
        <li className="is-now" key={task.id}>
          <i aria-hidden />
          <p>{task.title}<small>已授权 · 等待人工执行并回填证据 · rev {task.task_revision}</small></p>
          <span className="status-pill is-attention">待执行</span>
          <button className="primary-button" onClick={() => navigate(`/tasks/${task.id}`)} type="button">完成并回填证据 ›</button>
        </li>
      ))}
      {pending.map((task) => (
        <li className="is-done" key={task.id}>
          <i aria-hidden />
          <p>{task.title}<small>未授权 · 先走输入/审批链</small></p>
          <span className="status-pill">{task.status}</span>
          <button className="secondary-button" onClick={() => navigate(`/tasks/${task.id}`)} type="button">打开</button>
        </li>
      ))}
      {approved.length === 0 && pending.length === 0
        ? <li><i aria-hidden /><p>本轮任务已全部走完</p><span /><span /></li>
        : null}
    </ul>
  </section>;
}
