import { BarChart3, ClipboardCheck, ListChecks, Search } from "lucide-react";
import type { ReactNode } from "react";
import type { SpecialistArtifactWire } from "../../api/types";
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

const TYPE_META: Record<SpecialistArtifactWire["artifact_type"], {
  label: string;
  eyebrow: string;
  icon: ReactNode;
}> = {
  KEYWORD_SET: { label: "关键词集", eyebrow: "KEYWORD EVIDENCE", icon: <Search aria-hidden size={15} /> },
  AUDIT_REPORT: { label: "Audit", eyebrow: "EVIDENCE-BOUNDED AUDIT", icon: <ClipboardCheck aria-hidden size={15} /> },
  RANKING_SNAPSHOT: { label: "排名基线", eyebrow: "LOCAL + ORGANIC", icon: <BarChart3 aria-hidden size={15} /> },
  EXECUTION_PLAN: { label: "执行 Plan", eyebrow: "ORDERED WORK", icon: <ListChecks aria-hidden size={15} /> },
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
  const workItems = asArray(artifact.payload.work_items) as PlanWorkItem[];
  const days = typeof artifact.payload.horizon_days === "number" ? artifact.payload.horizon_days : "—";
  return `${days} 天 · ${workItems.length} 项工作`;
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
  const workItems = asArray(artifact.payload.work_items) as PlanWorkItem[];
  return <ul className="artifact-plan-items">{workItems.slice(0, 8).map((item, index) => <li key={`${String(item.id)}-${index}`}>
    <span>{String(index + 1).padStart(2, "0")}</span>
    <strong>{String(item.title ?? "未命名工作项")}</strong>
    <em className={`is-${String(item.priority ?? "LOW").toLocaleLowerCase()}`}>{String(item.priority ?? "—")}</em>
  </li>)}</ul>;
}

function EvidenceLimits({ values }: { values: string[] }) {
  if (!values.length) return null;
  return <div className="artifact-limits"><strong>证据边界</strong>{values.slice(0, 3).map((value) => <span key={value}>{value}</span>)}</div>;
}

export function SpecialistArtifactsPanel({ artifacts, compact = false }: {
  artifacts: SpecialistArtifactWire[];
  compact?: boolean;
}) {
  if (!artifacts.length) return null;
  return <section className={`data-panel specialist-artifacts${compact ? " is-compact" : ""}`}>
    <div className="panel-heading"><div><span className="eyebrow">ACCEPTED AGENT OUTPUTS</span><h2>Agent 产物</h2><p className="quiet-copy">Core AI 负责生成；SEO Ops 校验结构、落库并推进任务。</p></div><span className="result-count">{artifacts.length} 项</span></div>
    <div className="specialist-artifact-grid">{artifacts.slice(0, compact ? 3 : 12).map((artifact) => {
      const meta = TYPE_META[artifact.artifact_type];
      return <article className={`artifact-card is-${artifact.artifact_type.toLocaleLowerCase()}`} key={artifact.id}>
        <header><div className="artifact-type-icon">{meta.icon}</div><div><span className="eyebrow">{meta.eyebrow}</span><strong>{meta.label}</strong></div><time dateTime={artifact.created_at}>{formatDateTime(artifact.created_at)}</time></header>
        <h3>{artifact.title}</h3>
        <p>{artifact.summary}</p>
        <div className="artifact-count">{countLabel(artifact)}</div>
        <ArtifactDetails artifact={artifact} />
        <footer><code>{artifact.schema_version}</code><span>Run {artifact.core_run_id.slice(0, 8)}…</span></footer>
      </article>;
    })}</div>
  </section>;
}
