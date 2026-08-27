import { describe, expect, it } from "vitest";
import {
  resolveRuntimeRole,
  runtimePolicy,
} from "../src/runtime/role.js";
import { startRuntimeComponents } from "../src/runtime/start.js";

describe("SEO Ops runtime roles", () => {
  it("defaults local development to the combined runtime", () => {
    expect(resolveRuntimeRole(undefined, "development")).toBe("all");
    expect(resolveRuntimeRole(undefined, "test")).toBe("all");
  });

  it("requires one isolated role in production", () => {
    expect(resolveRuntimeRole("api", "production")).toBe("api");
    expect(resolveRuntimeRole("worker", "production")).toBe("worker");
    expect(resolveRuntimeRole("scheduler", "production")).toBe("scheduler");
    expect(() => resolveRuntimeRole(undefined, "production")).toThrow(
      "SEO_OPS_RUNTIME_ROLE must be api, worker, or scheduler in production",
    );
    expect(() => resolveRuntimeRole("all", "production")).toThrow(
      "SEO_OPS_RUNTIME_ROLE must be api, worker, or scheduler in production",
    );
  });

  it("rejects unknown role names in every environment", () => {
    expect(() => resolveRuntimeRole("api-and-worker", "development")).toThrow(
      "SEO_OPS_RUNTIME_ROLE must be api, worker, scheduler, or all",
    );
  });

  it("keeps HTTP, asynchronous workers, and scheduling isolated", () => {
    expect(runtimePolicy("api")).toEqual({ http: true, workers: false, scheduler: false });
    expect(runtimePolicy("worker")).toEqual({ http: false, workers: true, scheduler: false });
    expect(runtimePolicy("scheduler")).toEqual({ http: false, workers: false, scheduler: true });
    expect(runtimePolicy("all")).toEqual({ http: true, workers: true, scheduler: true });
  });

  it("starts only the component family selected by the role", () => {
    const starts = { poller: 0, execution: 0, gbp: 0, scheduler: 0 };
    const component = (key: keyof typeof starts) => ({
      start: () => { starts[key] += 1; },
      stop: () => undefined,
    });
    const components = {
      poller: component("poller"),
      executionWorker: component("execution"),
      gbpExecutionWorker: component("gbp"),
      scheduler: component("scheduler"),
    };

    startRuntimeComponents("api", components);
    expect(starts).toEqual({ poller: 0, execution: 0, gbp: 0, scheduler: 0 });
    startRuntimeComponents("worker", components);
    expect(starts).toEqual({ poller: 1, execution: 1, gbp: 1, scheduler: 0 });
    startRuntimeComponents("scheduler", components);
    expect(starts).toEqual({ poller: 1, execution: 1, gbp: 1, scheduler: 1 });
  });
});
