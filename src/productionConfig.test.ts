import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("packages the application at the SEO Ops base path as non-root nginx", () => {
  const vite = readFileSync("vite.config.ts", "utf8");
  const nginx = readFileSync("nginx.conf", "utf8");
  const docker = readFileSync("Dockerfile", "utf8");
  const workflow = readFileSync(".github/workflows/build.yml", "utf8");
  expect(vite).toContain('base: "/seo-ops/"');
  expect(nginx).toContain("listen 8080");
  expect(nginx).toContain("location = /seo-ops/healthz");
  expect(docker).toContain("nginx-unprivileged");
  expect(workflow).toContain("npm ci");
  expect(workflow).toContain("chancetop/connexup-seo-ops");
  expect(workflow).toContain("VERSION");
});
