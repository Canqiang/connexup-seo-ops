import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgentRun, upsertDeliverable } from "../src/repos/agentRunRepo.js";
import type { Db } from "../src/db/connection.js";
import {
  deriveRankingOverview,
  parseRankingCsv,
  type RankingSnapshot,
} from "../src/services/rankingService.js";
import { createAuthenticatedTestApp } from "./helpers/authTest.js";

const CSV = [
  "keyword,local_rank,organic_rank,checked_at",
  "ramen near me,12,8,2026-08-11",
  "best ramen flushing,9,15,2026-08-11",
  "tonkotsu ramen,-,22,2026-08-11",
].join("\n");

describe("parseRankingCsv", () => {
  it("parses header-mapped rows and null ranks for non-numeric cells", () => {
    const rows = parseRankingCsv(CSV);
    expect(rows).toEqual([
      { keyword: "ramen near me", localRank: 12, organicRank: 8 },
      { keyword: "best ramen flushing", localRank: 9, organicRank: 15 },
      { keyword: "tonkotsu ramen", localRank: null, organicRank: 22 },
    ]);
  });

  it("tolerates BOM, CRLF, column reorder, and quoted keywords with commas", () => {
    const text = "﻿organic_rank,keyword,local_rank\r\n3,\"ramen, veggie\",7\r\n";
    expect(parseRankingCsv(text)).toEqual([
      { keyword: "ramen, veggie", localRank: 7, organicRank: 3 },
    ]);
  });

  it("returns [] when the keyword column is missing, skips blank/short lines", () => {
    expect(parseRankingCsv("foo,bar\n1,2\n")).toEqual([]);
    expect(parseRankingCsv("keyword,local_rank,organic_rank\n\nsolo\n")).toEqual([]);
  });

  it("treats out-of-pack markers (>20, 20+, NA, empty) as null", () => {
    const text = "keyword,local_rank,organic_rank\nw1,>20,20+\nw2,NA,\n";
    expect(parseRankingCsv(text)).toEqual([
      { keyword: "w1", localRank: null, organicRank: null },
      { keyword: "w2", localRank: null, organicRank: null },
    ]);
  });
});

function snapshot(
  runId: string,
  capturedAt: string,
  rows: Array<[string, number | null, number | null]>,
): RankingSnapshot {
  return {
    runId,
    capturedAt,
    rows: rows.map(([keyword, localRank, organicRank]) => ({ keyword, localRank, organicRank })),
  };
}

describe("deriveRankingOverview", () => {
  it("empty -> zero rounds and no latest", () => {
    expect(deriveRankingOverview([])).toEqual({
      round_count: 0,
      latest: null,
      previous: null,
      comparison: null,
    });
  });

  it("single snapshot -> table without deltas, no comparison", () => {
    const wire = deriveRankingOverview([
      snapshot("run-1", "2026-08-15T10:00:00.000Z", [["ramen near me", 12, 8]]),
    ]);
    expect(wire.round_count).toBe(1);
    expect(wire.comparison).toBeNull();
    expect(wire.previous).toBeNull();
    expect(wire.latest).toEqual({
      run_id: "run-1",
      captured_at: "2026-08-15T10:00:00.000Z",
      keyword_count: 1,
      rows: [{
        keyword: "ramen near me",
        local_rank: 12, organic_rank: 8,
        local_delta: null, organic_delta: null,
        is_new: false,
      }],
    });
  });

  it("two snapshots -> averages, top10 share, new keywords, per-row deltas", () => {
    // 上期：均值 (12+16)/2=14；本期：均值 (9+13)/2=11 -> delta +3（上升 3 位）
    const wire = deriveRankingOverview([
      snapshot("run-2", "2026-08-15T10:00:00.000Z", [
        ["ramen near me", 9, 8],
        ["best ramen flushing", 13, 15],
        ["tonkotsu ramen", null, 12],
        ["ramen delivery", 5, null], // 新挖机会词
      ]),
      snapshot("run-1", "2026-08-08T10:00:00.000Z", [
        ["ramen near me", 12, 11],
        ["best ramen flushing", 16, 15],
        ["tonkotsu ramen", null, 9],
      ]),
    ]);
    expect(wire.round_count).toBe(2);
    expect(wire.previous).toEqual({ run_id: "run-1", captured_at: "2026-08-08T10:00:00.000Z" });
    expect(wire.comparison).toEqual({
      local_avg: { current: 9, previous: 14, delta: 5 },
      organic_top10: { current: 1, previous: 1, total: 4 },
      new_keyword_count: 1,
    });
    const byKeyword = Object.fromEntries(wire.latest!.rows.map((r) => [r.keyword, r]));
    expect(byKeyword["ramen near me"]).toMatchObject({ local_delta: 3, organic_delta: 3, is_new: false });
    expect(byKeyword["best ramen flushing"]).toMatchObject({ local_delta: 3, organic_delta: 0 });
    expect(byKeyword["tonkotsu ramen"]).toMatchObject({ local_delta: null, organic_delta: -3 });
    expect(byKeyword["ramen delivery"]).toMatchObject({ local_delta: null, organic_delta: null, is_new: true });
  });

  it("averages skip unranked keywords and round to one decimal", () => {
    const wire = deriveRankingOverview([
      snapshot("run-2", "2026-08-15T10:00:00.000Z", [["a", 1, null], ["b", 2, null], ["c", null, null]]),
      snapshot("run-1", "2026-08-08T10:00:00.000Z", [["a", 2, null], ["b", 3, null], ["c", null, null]]),
    ]);
    expect(wire.comparison?.local_avg).toEqual({ current: 1.5, previous: 2.5, delta: 1 });
    // 全部无排名 -> 均值为 null，delta 为 null
    const none = deriveRankingOverview([
      snapshot("run-2", "2026-08-15T10:00:00.000Z", [["a", null, null]]),
      snapshot("run-1", "2026-08-08T10:00:00.000Z", [["a", null, null]]),
    ]);
    expect(none.comparison?.local_avg).toEqual({ current: null, previous: null, delta: null });
  });
});

describe("GET /api/seo-ops/merchants/:merchantId/ranking", () => {
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), "ranking-routes-"));
  });

  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** Fresh app + fresh schema-isolated postgres db per call. */
  async function makeApp() {
    return createAuthenticatedTestApp({ deps: { coreAi: null, artifactsDir } });
  }

  type TestApp = Awaited<ReturnType<typeof makeApp>>["app"];

  async function createMerchant(app: TestApp) {
    const response = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "sakura-ramen",
        display_name: "Sakura Ramen",
        idempotency_key: "m-1",
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  async function seedRankingRun(
    db: Db,
    merchantId: string,
    runId: string,
    completedAt: string,
    csv: string | null,
  ) {
    await insertAgentRun(db, {
      id: runId,
      merchantId,
      locationId: null,
      stage: "RANKING_BASELINE",
      taskId: null,
      runType: "REPORT",
      goal: null,
      status: "COMPLETED",
      coreRunId: "core-1",
      coreStatus: "COMPLETED",
      inputMessage: "sop",
      output: "# 排名基线",
      error: null,
      errorCode: null,
      tokenUsage: {},
      triggeredBy: "test",
      triggeredAt: completedAt,
      lastPolledAt: null,
      completedAt,
      creationIdempotencyKey: null,
      requestFingerprint: null,
      createdBy: "test",
      createdAt: completedAt,
      updatedAt: completedAt,
    });
    if (csv !== null) {
      const filePath = path.join(artifactsDir, `${runId}-0-ranking.csv`);
      writeFileSync(filePath, csv, "utf8");
      await upsertDeliverable(db, {
        id: `${runId}-att-0`,
        runId,
        kind: "ATTACHMENT",
        fileId: "f-1",
        fileName: "ranking.csv",
        contentType: "text/csv",
        size: csv.length,
        title: null,
        description: null,
        sha256: "sha256:test",
        localPath: filePath,
        remoteUrl: null,
        downloadedAt: completedAt,
        downloadError: null,
        createdAt: completedAt,
      });
    }
  }

  it("404 on unknown merchant", async () => {
    const { app } = await makeApp();
    try {
      const response = await app.inject({ method: "GET", url: "/api/seo-ops/merchants/nope/ranking" });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("derives the overview from CSV deliverables of completed ranking runs", async () => {
    const { app, db } = await makeApp();
    try {
      const merchantId = await createMerchant(app);
      await seedRankingRun(db, merchantId, "run-old", "2026-08-08T10:00:00.000Z",
        "keyword,local_rank,organic_rank\nramen near me,12,11\n");
      await seedRankingRun(db, merchantId, "run-new", "2026-08-15T10:00:00.000Z",
        "keyword,local_rank,organic_rank\nramen near me,9,8\nramen delivery,5,30\n");
      // 无附件的运行不算快照
      await seedRankingRun(db, merchantId, "run-empty", "2026-08-16T10:00:00.000Z", null);

      const response = await app.inject({
        method: "GET",
        url: `/api/seo-ops/merchants/${merchantId}/ranking`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.round_count).toBe(2);
      expect(body.latest.run_id).toBe("run-new");
      expect(body.latest.captured_at).toBe("2026-08-15T10:00:00.000Z");
      expect(body.previous.run_id).toBe("run-old");
      expect(body.comparison.local_avg).toEqual({ current: 7, previous: 12, delta: 5 });
      expect(body.comparison.new_keyword_count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("no ranking runs -> empty overview instead of 404", async () => {
    const { app } = await makeApp();
    try {
      const merchantId = await createMerchant(app);
      const response = await app.inject({
        method: "GET",
        url: `/api/seo-ops/merchants/${merchantId}/ranking`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ round_count: 0, latest: null, previous: null, comparison: null });
    } finally {
      await app.close();
    }
  });
});
