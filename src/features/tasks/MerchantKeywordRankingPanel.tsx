import { BarChart3, Search } from "lucide-react";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { SpecialistArtifactWire } from "../../api/types";
import { formatDateTime } from "../../app/format";
import { useResource } from "../../hooks/useResource";

interface KeywordItem {
  keyword?: unknown;
  strategy?: unknown;
  intent?: unknown;
  priority?: unknown;
}

interface RankingItem {
  keyword?: unknown;
  local_rank?: unknown;
  organic_rank?: unknown;
  arp?: unknown;
  solv_percent?: unknown;
  source?: unknown;
}

function latest(items: SpecialistArtifactWire[], type: SpecialistArtifactWire["artifact_type"]) {
  return items
    .filter((item) => item.artifact_type === type)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function rankLabel(value: unknown, hasSnapshot: boolean): string {
  if (typeof value === "number") return `#${value}`;
  return hasSnapshot ? "Top 20 未出现" : "尚未采集";
}

export function MerchantKeywordRankingPanel({ merchantId }: { merchantId: string }) {
  const resource = useResource((signal) => seoOpsApi.merchantArtifacts(merchantId, undefined, signal), [merchantId]);
  if (resource.loading && !resource.data) return <section className="data-panel keyword-ranking-panel"><div className="page-state" role="status">读取关键词与排名…</div></section>;
  if (resource.error) return <section className="data-panel keyword-ranking-panel"><div className="page-state is-error" role="alert">关键词排名读取失败。<button onClick={resource.reload} type="button">重试</button></div></section>;

  const keywordArtifact = latest(resource.data?.items ?? [], "KEYWORD_SET");
  const rankingArtifact = latest(resource.data?.items ?? [], "RANKING_SNAPSHOT");
  const keywords = records(keywordArtifact?.payload.keywords) as KeywordItem[];
  const rankings = records(rankingArtifact?.payload.keywords) as RankingItem[];
  const rankingByKeyword = new Map(rankings.map((item) => [String(item.keyword ?? "").toLocaleLowerCase(), item]));
  const keywordByKey = new Map(keywords.map((item) => [String(item.keyword ?? "").toLocaleLowerCase(), item]));
  for (const item of rankings) {
    const key = String(item.keyword ?? "").toLocaleLowerCase();
    if (key && !keywordByKey.has(key)) keywordByKey.set(key, { keyword: item.keyword });
  }
  const rows = [...keywordByKey.values()].filter((item) => String(item.keyword ?? "").trim() !== "");
  const capturedAt = typeof rankingArtifact?.payload.captured_at === "string"
    ? rankingArtifact.payload.captured_at
    : rankingArtifact?.created_at;
  const sourceMode = typeof rankingArtifact?.payload.source_mode === "string"
    ? rankingArtifact.payload.source_mode
    : "暂无排名快照";
  const hasGridMetrics = rankings.some((item) => typeof item.arp === "number" || typeof item.solv_percent === "number");
  const measured = rankings.filter((item) => typeof item.local_rank === "number" || typeof item.organic_rank === "number" || typeof item.arp === "number" || typeof item.solv_percent === "number").length;

  return <section aria-label="关键词与排名" className="data-panel keyword-ranking-panel">
    <div className="panel-heading"><div><span className="eyebrow">SEARCH INPUT / 选题依据</span><h2><Search size={15} /> 关键词与排名</h2><p className="quiet-copy">{rankingArtifact ? "本店关键词库与同口径只读排名；排名快照中的空值表示采样 Top 20 未出现，不代表第 0 名。" : "本店关键词库已接入；排名尚未采集，不展示推测值。"}</p></div>
      <div className="keyword-ranking-stats"><strong>{rows.length} 个目标词</strong><span>{measured} 个测得排名</span></div></div>
    {!keywordArtifact && !rankingArtifact ? <div className="empty-state slim"><p>还没有可展示的关键词或排名证据。</p></div> : <>
      <div className="keyword-ranking-meta"><span><BarChart3 size={13} /> {sourceMode}</span><span>{capturedAt ? formatDateTime(capturedAt) : "尚未采集"}</span><span>{rankingArtifact ? (rankingArtifact.acceptance_status === "ACCEPTED" ? "已验收" : "待人工验收") : (keywordArtifact?.acceptance_status === "ACCEPTED" ? "关键词已验收" : "待人工验收")}</span></div>
      <div className="keyword-ranking-scroll"><table className="keyword-ranking-table"><thead><tr><th>关键词</th><th>策略 / 意图</th><th>优先级</th><th>{hasGridMetrics ? "Map ARP" : "Local"}</th><th>{hasGridMetrics ? "可见度" : "Organic"}</th></tr></thead><tbody>
        {rows.map((keyword) => {
          const value = String(keyword.keyword);
          const ranking = rankingByKeyword.get(value.toLocaleLowerCase());
          return <tr key={value}><th scope="row">{value}</th><td>{String(keyword.strategy ?? keyword.intent ?? "—")}</td><td>{String(keyword.priority ?? "UNSCORED")}</td>{hasGridMetrics ? <><td className={typeof ranking?.arp === "number" ? "is-ranked" : "is-unranked"}>{typeof ranking?.arp === "number" ? ranking.arp.toFixed(2) : "未采集"}</td><td className={typeof ranking?.solv_percent === "number" ? "is-ranked" : "is-unranked"}>{typeof ranking?.solv_percent === "number" ? `${ranking.solv_percent.toFixed(2)}%` : "未采集"}</td></> : <><td className={typeof ranking?.local_rank === "number" ? "is-ranked" : "is-unranked"}>{rankLabel(ranking?.local_rank, Boolean(rankingArtifact))}</td><td className={typeof ranking?.organic_rank === "number" ? "is-ranked" : "is-unranked"}>{rankLabel(ranking?.organic_rank, Boolean(rankingArtifact))}</td></>}</tr>;
        })}
      </tbody></table></div>
    </>}
  </section>;
}
