import fs from "node:fs";
import type { Db } from "../db/connection.js";
import {
  listAgentRunsByMerchant,
  listDeliverablesByRunIds,
} from "../repos/agentRunRepo.js";
import type { RunDeliverable } from "../repos/agentRunTypes.js";

/** 排名快照：从 RANKING_BASELINE 运行的 CSV 附件（keyword,local_rank,organic_rank,
 * checked_at）解析而来，不落表——与生命周期同一原则，一切从交付物链推导。 */
export interface RankingRow {
  keyword: string;
  localRank: number | null;
  organicRank: number | null;
}

export interface RankingSnapshot {
  runId: string;
  capturedAt: string;
  rows: RankingRow[];
}

export interface RankingRowWire {
  keyword: string;
  local_rank: number | null;
  organic_rank: number | null;
  /** 较上期位次变化（上期 - 本期，正数 = 上升）；任一期无排名则为 null。 */
  local_delta: number | null;
  organic_delta: number | null;
  /** 本期新出现的词（上期快照里没有）。 */
  is_new: boolean;
}

export interface RankingOverviewWire {
  /** 轮次 = 可解析出快照的排名运行次数（首轮基线 + 每次复查）。 */
  round_count: number;
  latest: {
    run_id: string;
    captured_at: string;
    keyword_count: number;
    rows: RankingRowWire[];
  } | null;
  previous: { run_id: string; captured_at: string } | null;
  /** 与上期对比（只放数字，不做图表）；不足两期为 null。 */
  comparison: {
    local_avg: {
      current: number | null;
      previous: number | null;
      delta: number | null;
    };
    organic_top10: { current: number; previous: number; total: number };
    new_keyword_count: number;
  } | null;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else inQuotes = false;
      } else current += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      cells.push(current);
      current = "";
    } else current += ch;
  }
  cells.push(current);
  return cells;
}

/** 位次只认正整数；">20"、"20+"、"NA"、空串等出包标记一律 null（无排名）。 */
function parseRank(cell: string | undefined): number | null {
  const trimmed = (cell ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return value >= 1 ? value : null;
}

export function parseRankingCsv(text: string): RankingRow[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]!).map((cell) => cell.trim().toLowerCase());
  const keywordIdx = header.indexOf("keyword");
  if (keywordIdx === -1) return [];
  const localIdx = header.indexOf("local_rank");
  const organicIdx = header.indexOf("organic_rank");

  const rows: RankingRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    if (cells.length < 2) continue; // 缺列的残行不猜
    const keyword = (cells[keywordIdx] ?? "").trim();
    if (!keyword) continue;
    rows.push({
      keyword,
      localRank: localIdx === -1 ? null : parseRank(cells[localIdx]),
      organicRank: organicIdx === -1 ? null : parseRank(cells[organicIdx]),
    });
  }
  return rows;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function localAvg(rows: RankingRow[]): number | null {
  const ranked = rows.filter((r) => r.localRank !== null);
  if (ranked.length === 0) return null;
  return round1(
    ranked.reduce((sum, r) => sum + (r.localRank ?? 0), 0) / ranked.length,
  );
}

function organicTop10(rows: RankingRow[]): number {
  return rows.filter((r) => r.organicRank !== null && r.organicRank <= 10).length;
}

/** snapshots 按时间倒序（最新在前）。 */
export function deriveRankingOverview(
  snapshots: RankingSnapshot[],
): RankingOverviewWire {
  const latest = snapshots[0] ?? null;
  if (!latest) {
    return { round_count: 0, latest: null, previous: null, comparison: null };
  }
  const previous = snapshots[1] ?? null;
  const previousByKeyword = new Map(
    (previous?.rows ?? []).map((row) => [row.keyword, row]),
  );

  const rows: RankingRowWire[] = latest.rows.map((row) => {
    const prior = previous ? previousByKeyword.get(row.keyword) ?? null : null;
    return {
      keyword: row.keyword,
      local_rank: row.localRank,
      organic_rank: row.organicRank,
      local_delta:
        prior && prior.localRank !== null && row.localRank !== null
          ? prior.localRank - row.localRank
          : null,
      organic_delta:
        prior && prior.organicRank !== null && row.organicRank !== null
          ? prior.organicRank - row.organicRank
          : null,
      is_new: previous !== null && !previousByKeyword.has(row.keyword),
    };
  });

  let comparison: RankingOverviewWire["comparison"] = null;
  if (previous) {
    const current = localAvg(latest.rows);
    const prior = localAvg(previous.rows);
    comparison = {
      local_avg: {
        current,
        previous: prior,
        delta: current !== null && prior !== null ? round1(prior - current) : null,
      },
      organic_top10: {
        current: organicTop10(latest.rows),
        previous: organicTop10(previous.rows),
        total: latest.rows.length,
      },
      new_keyword_count: rows.filter((row) => row.is_new).length,
    };
  }

  return {
    round_count: snapshots.length,
    latest: {
      run_id: latest.runId,
      captured_at: latest.capturedAt,
      keyword_count: rows.length,
      rows,
    },
    previous: previous
      ? { run_id: previous.runId, captured_at: previous.capturedAt }
      : null,
    comparison,
  };
}

function looksLikeCsv(deliverable: RunDeliverable): boolean {
  return (
    (deliverable.contentType ?? "").toLowerCase().includes("csv") ||
    (deliverable.fileName ?? "").toLowerCase().endsWith(".csv")
  );
}

/** 每个 COMPLETED 排名运行取第一个可解析的 CSV 附件为一期快照（最新在前）。
 * 文件缺失/解析失败的运行自然跳过——不算轮次也不参与对比。 */
export async function loadRankingSnapshots(
  db: Db,
  merchantId: string,
): Promise<RankingSnapshot[]> {
  const runs = (await listAgentRunsByMerchant(db, merchantId)).filter(
    (run) => run.stage === "RANKING_BASELINE" && run.status === "COMPLETED",
  );
  const deliverablesByRun = await listDeliverablesByRunIds(
    db,
    runs.map((run) => run.id),
  );

  const snapshots: RankingSnapshot[] = [];
  for (const run of runs) {
    const candidates = (deliverablesByRun.get(run.id) ?? []).filter(
      (d) => d.kind !== "SUMMARY" && d.localPath !== null && looksLikeCsv(d),
    );
    for (const deliverable of candidates) {
      let text: string;
      try {
        text = fs.readFileSync(deliverable.localPath!, "utf8");
      } catch {
        continue;
      }
      const rows = parseRankingCsv(text);
      if (rows.length > 0) {
        snapshots.push({
          runId: run.id,
          capturedAt: run.completedAt ?? run.createdAt,
          rows,
        });
        break;
      }
    }
  }
  return snapshots;
}
