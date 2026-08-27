import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Every integration-test file owns an isolated PostgreSQL schema and pool.
    // Running all files concurrently can exhaust the local/UAT database before
    // the assertions start, producing misleading hook timeouts. Keep cases
    // within each file deterministic and run the database-backed files in one
    // worker; focused test commands remain fast.
    fileParallelism: false,
  },
});
