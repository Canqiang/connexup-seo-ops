import {
  Activity,
  BarChart3,
  ClipboardCheck,
  FileQuestion,
  FileText,
  LineChart,
  ListChecks,
  Search,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { SpecialistArtifactWire } from "../../api/types";
import { seoOpsApi } from "../../api/seoOpsApi";
import { formatDateTime } from "../../app/format";

interface KeywordItem {
  keyword?: unknown;
  priority?: unknown;
  intent?: unknown;
  strategy?: unknown;
}

interface AuditFinding {
  id?: unknown;
  area?: unknown;
  severity?: unknown;
  observation?: unknown;
}

interface PlanWorkItem {
  id?: unknown;
  title?: unknown;
  priority?: unknown;
  due_offset_days?: unknown;
}

interface RankingItem {
  keyword?: unknown;
  local_rank?: unknown;
  organic_rank?: unknown;
  source?: unknown;
}

interface ClusterSignalItem {
  cluster?: unknown;
  signal?: unknown;
}

interface ArtifactTypeMeta {
  label: string;
  eyebrow: string;
  icon: ReactNode;
}

const TYPE_META: Record<string, ArtifactTypeMeta> = {
  KEYWORD_SET: { label: "关键词集", eyebrow: "KEYWORD EVIDENCE", icon: <Search aria-hidden size={15} /> },
  KEYWORD_WEEKLY: { label: "周度关键词信号", eyebrow: "ASSOCIATIVE READING", icon: <LineChart aria-hidden size={15} /> },
  AUDIT_REPORT: { label: "Audit", eyebrow: "EVIDENCE-BOUNDED AUDIT", icon: <ClipboardCheck aria-hidden size={15} /> },
  RANKING_SNAPSHOT: { label: "排名基线", eyebrow: "LOCAL + ORGANIC", icon: <BarChart3 aria-hidden size={15} /> },
  EXECUTION_PLAN: { label: "执行 Plan", eyebrow: "ORDERED WORK", icon: <ListChecks aria-hidden size={15} /> },
  EFFECT_REVIEW: { label: "复盘分析", eyebrow: "ASSOCIATION-CAPPED REVIEW", icon: <Activity aria-hidden size={15} /> },
  MERCHANT_REPORT: { label: "商户报告", eyebrow: "FROZEN MERCHANT REPORT", icon: <FileText aria-hidden size={15} /> },
};

const UNKNOWN_META: ArtifactTypeMeta = {
  label: "未知 Agent 产物",
  eyebrow: "UNRECOGNIZED ARTIFACT",
  icon: <FileQuestion aria-hidden size={15} />,
};

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function countLabel(artifact: SpecialistArtifactWire): string {
  if (artifact.artifact_type === "KEYWORD_SET") {
    const keywords = asArray(artifact.payload.keywords) as KeywordItem[];
    if (artifact.payload.generation_method === "EVIDENCE_BOUNDED_RESEARCH") {
      return `${keywords.length} 个候选词 · 未进入 P0–P3 评分`;
    }
    const primary = keywords.filter((item) => item.priority === "P0" || item.priority === "P1").length;
    return `${keywords.length} 个词 · ${primary} 个 P0/P1`;
  }
  if (artifact.artifact_type === "KEYWORD_WEEKLY") {
    return `${asArray(artifact.payload.cluster_signals).length} 个簇 · 关联信号`;
  }
  if (artifact.artifact_type === "AUDIT_REPORT") {
    const findings = asArray(artifact.payload.findings) as AuditFinding[];
    const high = findings.filter((item) => item.severity === "HIGH" || item.severity === "CRITICAL").length;
    return `${findings.length} 项发现 · ${high} 项高风险`;
  }
  if (artifact.artifact_type === "RANKING_SNAPSHOT") {
    const keywords = asArray(artifact.payload.keywords) as RankingItem[];
    const measured = keywords.filter((item) => typeof item.local_rank === "number" || typeof item.organic_rank === "number").length;
    return `${keywords.length} 个词 · ${measured} 个已测排名`;
  }
  if (artifact.artifact_type === "EXECUTION_PLAN") {
    const workItems = asArray(artifact.payload.work_items) as PlanWorkItem[];
    const days = typeof artifact.payload.horizon_days === "number" ? artifact.payload.horizon_days : "—";
    return `${days} 天 · ${workItems.length} 项工作`;
  }
  if (artifact.artifact_type === "EFFECT_REVIEW") {
    const tier = typeof artifact.payload.conclusion_tier === "string"
      ? artifact.payload.conclusion_tier
      : "INSUFFICIENT_EVIDENCE";
    return `${tier} · ${asArray(artifact.payload.action_bundle).length} 项已执行动作`;
  }
  if (artifact.artifact_type === "MERCHANT_REPORT") {
    const version = typeof artifact.payload.report_version === "string"
      ? artifact.payload.report_version
      : "未标版本";
    return `${version} · ${asArray(artifact.payload.sections).length} 个章节`;
  }
  return "未知结构 · 安全回退";
}

function ArtifactDetails({ artifact }: { artifact: SpecialistArtifactWire }) {
  if (artifact.artifact_type === "KEYWORD_SET") {
    const keywords = asArray(artifact.payload.keywords) as KeywordItem[];
    return <>
      <div className="artifact-method">
        <span>{artifact.payload.generation_method === "UPSTREAM_DETERMINISTIC_ADAPTER" ? "确定性链路适配" : "证据受限研究"}</span>
        <small>{String((artifact.payload.market as Record<string, unknown> | undefined)?.country_code ?? "—")} · {String((artifact.payload.market as Record<string, unknown> | undefined)?.language ?? "—")}</small>
      </div>
      <ul className="artifact-keywords">{keywords.slice(0, 8).map((item, index) => <li key={`${String(item.keyword)}-${index}`}>
        <strong>{String(item.keyword ?? "未命名关键词")}</strong>
        <span>{String(item.strategy ?? item.intent ?? "—")}</span>
        <em className={`is-${String(item.priority ?? "LOW").toLocaleLowerCase()}`}>{String(item.priority ?? "—")}</em>
      </li>)}</ul>
      <EvidenceLimits values={asStrings(artifact.payload.evidence_gaps)} />
    </>;
  }
  if (artifact.artifact_type === "KEYWORD_WEEKLY") {
    const signals = asArray(artifact.payload.cluster_signals) as ClusterSignalItem[];
    return <ul className="artifact-keywords">{signals.slice(0, 8).map((item, index) => <li key={`${String(item.cluster)}-${index}`}>
      <strong>{String(item.cluster ?? "未命名关键词簇")}</strong>
      <span>关联读数</span>
      <em className={`is-${String(item.signal ?? "INCONCLUSIVE").toLocaleLowerCase()}`}>{String(item.signal ?? "INCONCLUSIVE")}</em>
    </li>)}</ul>;
  }
  if (artifact.artifact_type === "AUDIT_REPORT") {
    const findings = asArray(artifact.payload.findings) as AuditFinding[];
    return <>
      <ul className="artifact-findings">{findings.slice(0, 6).map((item, index) => <li key={`${String(item.id)}-${index}`}>
        <span className={`artifact-severity is-${String(item.severity ?? "INFO").toLocaleLowerCase()}`}>{String(item.severity ?? "INFO")}</span>
        <div><small>{String(item.area ?? "OTHER")}</small><strong>{String(item.observation ?? "未提供观察结果")}</strong></div>
      </li>)}</ul>
      <EvidenceLimits values={asStrings(artifact.payload.limitations)} />
    </>;
  }
  if (artifact.artifact_type === "RANKING_SNAPSHOT") {
    const keywords = asArray(artifact.payload.keywords) as RankingItem[];
    return <>
      <div className="artifact-ranking-head"><span>关键词</span><span>LOCAL</span><span>ORGANIC</span></div>
      <ul className="artifact-ranking">{keywords.slice(0, 8).map((item, index) => <li key={`${String(item.keyword)}-${index}`}>
        <strong>{String(item.keyword ?? "未命名关键词")}</strong>
        <span>{typeof item.local_rank === "number" ? item.local_rank : "—"}</span>
        <span>{typeof item.organic_rank === "number" ? item.organic_rank : "—"}</span>
      </li>)}</ul>
      <EvidenceLimits values={asStrings(artifact.payload.limitations)} />
    </>;
  }
  if (artifact.artifact_type === "EXECUTION_PLAN") {
    const workItems = asArray(artifact.payload.work_items) as PlanWorkItem[];
    return <ul className="artifact-plan-items">{workItems.slice(0, 8).map((item, index) => <li key={`${String(item.id)}-${index}`}>
      <span>{String(index + 1).padStart(2, "0")}</span>
      <strong>{String(item.title ?? "未命名工作项")}</strong>
      <em className={`is-${String(item.priority ?? "LOW").toLocaleLowerCase()}`}>{String(item.priority ?? "—")}</em>
    </li>)}</ul>;
  }
  if (artifact.artifact_type === "EFFECT_REVIEW") {
    return <>
      <div className="artifact-method">
        <span>{String(artifact.payload.conclusion_tier ?? "INSUFFICIENT_EVIDENCE")}</span>
        <small>仅陈述性 / 关联性结论，不升级为因果</small>
      </div>
      <p>{String(artifact.payload.conclusion ?? "尚无可展示的复盘结论。")}</p>
      <EvidenceLimits values={[
        ...asStrings(artifact.payload.confounders),
        ...asStrings(artifact.payload.limitations),
      ]} />
    </>;
  }
  if (artifact.artifact_type === "MERCHANT_REPORT") {
    const sections = asArray(artifact.payload.sections);
    return <>
      <div className="artifact-method">
        <span>{String(artifact.payload.report_version ?? "未标版本")}</span>
        <small>冻结于 {String(artifact.payload.frozen_at ?? "—")}</small>
      </div>
      <p>{String(artifact.payload.executive_summary ?? "尚无执行摘要。")}</p>
      <ul className="artifact-plan-items">{sections.slice(0, 8).map((section, index) => <li key={`${String(section.id)}-${index}`}>
        <span>{String(index + 1).padStart(2, "0")}</span>
        <strong>{String(section.title ?? "未命名章节")}</strong>
        <em>{asStrings(section.source_artifact_ids).length} SOURCE</em>
      </li>)}</ul>
      <EvidenceLimits values={asStrings(artifact.payload.limitations)} />
    </>;
  }
  return <div className="artifact-limits">
    <strong>兼容性回退</strong>
    <span>当前客户端尚未识别 {String(artifact.artifact_type)}，已保留标题、摘要与版本信息。</span>
  </div>;
}

function EvidenceLimits({ values }: { values: string[] }) {
  if (!values.length) return null;
  return <div className="artifact-limits"><strong>证据边界</strong>{values.slice(0, 3).map((value) => <span key={value}>{value}</span>)}</div>;
}

function AcceptanceBadge({ artifact }: { artifact: SpecialistArtifactWire }) {
  const status = artifact.acceptance_status;
  const label = status === "ACCEPTED"
    ? "已验收"
    : status === "REJECTED"
      ? "已拒绝"
      : status === "PENDING"
        ? "待验收"
        : "验收状态未知";
  return <span
    className={`artifact-acceptance is-${String(status ?? "UNKNOWN").toLocaleLowerCase()}`}
    title={artifact.acceptance_note ?? undefined}
  >{label}</span>;
}

export function SpecialistArtifactsPanel({
  artifacts,
  compact = false,
  canApprove = false,
  onRefresh,
}: {
  artifacts: SpecialistArtifactWire[];
  compact?: boolean;
  canApprove?: boolean;
  onRefresh?: () => void | Promise<void>;
}) {
  const [visibleArtifacts, setVisibleArtifacts] = useState(artifacts);
  const [busyId, setBusyId] = useState<string>();
  const [decisionError, setDecisionError] = useState<{ id: string; message: string }>();
  useEffect(() => setVisibleArtifacts(artifacts), [artifacts]);
  if (!visibleArtifacts.length) return null;
  const decide = async (artifact: SpecialistArtifactWire, decision: "ACCEPTED" | "REJECTED") => {
    setBusyId(artifact.id);
    setDecisionError(undefined);
    try {
      const readback = await seoOpsApi.decideArtifactAcceptance(artifact.id, { decision });
      if (!readback || readback.id !== artifact.id) {
        throw new Error("artifact acceptance readback does not match the requested artifact");
      }
      setVisibleArtifacts((current) => current.map((item) => item.id === readback.id ? readback : item));
      try {
        await onRefresh?.();
      } catch {
        setDecisionError({
          id: artifact.id,
          message: "验收决定已保存，但任务数据刷新失败，请手动刷新。",
        });
      }
    } catch {
      setDecisionError({ id: artifact.id, message: "验收决定保存失败，请重试。" });
    } finally {
      setBusyId(undefined);
    }
  };
  return <section className={`data-panel specialist-artifacts${compact ? " is-compact" : ""}`}>
    <div className="panel-heading"><div><span className="eyebrow">AGENT OUTPUT LEDGER</span><h2>Agent 产物</h2><p className="quiet-copy">Core AI 负责生成；SEO Ops 校验结构、落库并独立记录验收决定。</p></div><span className="result-count">{visibleArtifacts.length} 项</span></div>
    <div className="specialist-artifact-grid">{visibleArtifacts.slice(0, compact ? 3 : 12).map((artifact) => {
      const meta = TYPE_META[artifact.artifact_type] ?? UNKNOWN_META;
      return <article className={`artifact-card is-${String(artifact.artifact_type).toLocaleLowerCase()}`} key={artifact.id}>
        <header><div className="artifact-type-icon">{meta.icon}</div><div><span className="eyebrow">{meta.eyebrow}</span><strong>{meta.label}</strong><AcceptanceBadge artifact={artifact} /></div><time dateTime={artifact.created_at}>{formatDateTime(artifact.created_at)}</time></header>
        <h3>{artifact.title}</h3>
        <p>{artifact.summary}</p>
        <div className="artifact-count">{countLabel(artifact)}</div>
        <ArtifactDetails artifact={artifact} />
        {artifact.acceptance_status === "PENDING" ? <div className="artifact-decision">
          {canApprove ? <>
            <button disabled={busyId === artifact.id} onClick={() => void decide(artifact, "ACCEPTED")} type="button">接受{meta.label}</button>
            <button disabled={busyId === artifact.id} onClick={() => void decide(artifact, "REJECTED")} type="button">拒绝{meta.label}</button>
          </> : <p>当前账号只能查看产物验收状态。</p>}
        </div> : null}
        {decisionError?.id === artifact.id
          ? <p className="page-state is-error" role="alert">{decisionError.message}</p>
          : null}
        <footer><code>{artifact.schema_version}</code><span>Run {artifact.core_run_id.slice(0, 8)}…</span></footer>
      </article>;
    })}</div>
  </section>;
}
