import type { Db } from "../db/connection.js";
import { CORE_RUN_TERMINAL_STATUSES } from "../domain/enums.js";
import { ApiError } from "../errors.js";
import {
  getAgentRun,
  listActiveAgentRuns,
  transitionAgentRun,
} from "../repos/agentRunRepo.js";
import type { AgentRun } from "../repos/agentRunTypes.js";
import { applyTerminalTransition, recordDeliverables, type AgentRunIoDeps } from "./agentRunService.js";
import {
  hasValidTaskLinkedGbpContentScope,
  isTaskLinkedGbpContentRun,
} from "./agentRunScopeService.js";
import { acceptGbpPostContentRun, GbpPostImageError } from "./gbpPostContentService.js";

/** Injectable clock/scheduler so tests never sleep. */
export interface PollerScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface AgentRunPollerDeps extends AgentRunIoDeps {
  intervalMs?: number;
  now?: () => Date;
  scheduler?: PollerScheduler;
}

/** How long a TRIGGERING row may sit before we declare the trigger call
 * interrupted (server crash between row insert and core-ai response). The
 * core-ai side may hold an orphan run — read-only SOPs make that harmless. */
const TRIGGER_GRACE_MS = 60_000;

/** Sequential poller over active agent runs. Boot recovery is free: start()
 * fires pollOnce immediately, adopting any RUNNING rows left by a restart. */
export class AgentRunPoller {
  private handle: unknown = null;
  private polling = false;

  constructor(private readonly deps: AgentRunPollerDeps) {}

  start(): void {
    if (this.handle !== null) return;
    void this.pollOnce();
    const intervalMs = this.deps.intervalMs ?? 3000;
    const tick = () => {
      void this.pollOnce();
    };
    this.handle = this.deps.scheduler
      ? this.deps.scheduler.setInterval(tick, intervalMs)
      : setInterval(tick, intervalMs);
    // Don't hold the process open just for the poller.
    (this.handle as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.handle === null) return;
    if (this.deps.scheduler) this.deps.scheduler.clearInterval(this.handle);
    else clearInterval(this.handle as NodeJS.Timeout);
    this.handle = null;
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return; // re-entrancy guard: skip, next tick catches up
    this.polling = true;
    try {
      for (const run of await listActiveAgentRuns(this.deps.db)) {
        await this.processRun(run);
      }
    } catch (err) {
      this.warn(`poll cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.polling = false;
    }
  }

  private nowIso(): string {
    return (this.deps.now ? this.deps.now() : new Date()).toISOString();
  }

  private async failCorruptGbpScope(run: AgentRun): Promise<void> {
    const now = this.nowIso();
    await transitionAgentRun(this.deps.db, run.id, {
      status: "FAILED",
      output: null,
      error: "GBP Post content Run requires reconciliation",
      errorCode: "CONTENT_RUN_RECONCILIATION_REQUIRED",
      completedAt: now,
      lastPolledAt: now,
    }, [run.status]);
  }

  private async processRun(run: AgentRun): Promise<void> {
    if (isTaskLinkedGbpContentRun(run)
      && !await hasValidTaskLinkedGbpContentScope(this.deps.db, run)) {
      await this.failCorruptGbpScope(run);
      return;
    }

    if (run.status === "TRIGGERING") {
      const ageMs =
        (this.deps.now ? this.deps.now() : new Date()).getTime() -
        Date.parse(run.triggeredAt);
      if (ageMs > TRIGGER_GRACE_MS) {
        await transitionAgentRun(
          this.deps.db,
          run.id,
          {
            status: "FAILED",
            errorCode: "TRIGGER_INTERRUPTED",
            error:
              "trigger did not complete within 60s (server restart or crash); " +
              "core-ai may hold an orphan run",
            completedAt: this.nowIso(),
            lastPolledAt: this.nowIso(),
          },
          ["TRIGGERING"],
        );
      }
      return;
    }

    if (run.coreRunId === null) return; // defensive: RUNNING without a core id

    let core;
    try {
      core = await this.deps.client.getRun(run.coreRunId);
    } catch (err) {
      // Transient network failure — keep RUNNING, next tick retries.
      this.warn(
        `run ${run.id}: poll failed, staying RUNNING: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    // The row may have gone terminal (cancel route) while the fetch was out.
    const fresh = await getAgentRun(this.deps.db, run.id);
    if (!fresh || fresh.status !== "RUNNING") return;
    if (isTaskLinkedGbpContentRun(fresh)
      && !await hasValidTaskLinkedGbpContentScope(this.deps.db, fresh)) {
      await this.failCorruptGbpScope(fresh);
      return;
    }

    if ((CORE_RUN_TERMINAL_STATUSES as readonly string[]).includes(core.status)) {
      if (fresh.stage === "GBP_POST_CONTENT") {
        if (core.status === "COMPLETED") {
          try {
            await acceptGbpPostContentRun(this.deps, fresh, core);
          } catch (error) {
            const errorCode = error instanceof ApiError
              && error.code === "CONTENT_RUN_RECONCILIATION_REQUIRED"
              ? error.code
              : error instanceof GbpPostImageError
                ? error.code
                : "OUTPUT_INVALID";
            await transitionAgentRun(this.deps.db, fresh.id, {
              status: "FAILED",
              coreStatus: core.status,
              traceRef: core.trace_id ?? fresh.traceRef,
              output: core.output ?? null,
              error: error instanceof Error ? error.message : "invalid GBP Post content output",
              errorCode,
              completedAt: core.completed_at ?? this.nowIso(),
              lastPolledAt: this.nowIso(),
            }, ["RUNNING"]);
            return;
          }
        }
      } else {
        // Generic Runs retain tolerant multi-artifact semantics. GBP content
        // uses the stricter branch above and never records an unvalidated Core URL.
        await recordDeliverables(this.deps, fresh, core);
      }
      await applyTerminalTransition(this.deps, fresh, core);
    } else {
      await transitionAgentRun(
        this.deps.db,
        run.id,
        { coreStatus: core.status, traceRef: core.trace_id ?? fresh.traceRef, lastPolledAt: this.nowIso() },
        ["RUNNING"],
      );
    }
  }

  private warn(message: string): void {
    this.deps.log?.warn(`agent-run poller: ${message}`);
  }
}
