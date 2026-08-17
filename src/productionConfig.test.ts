import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { resolveConfig } from "vite";

test("packages the application at the SEO Ops base path as non-root nginx", async () => {
  const vite = readFileSync("vite.config.ts", "utf8");
  const nginx = readFileSync("nginx.conf", "utf8");
  const docker = readFileSync("Dockerfile", "utf8");
  const workflow = readFileSync(".github/workflows/build.yml", "utf8");
  const packageJson = readFileSync("package.json", "utf8");
  expect(vite).toContain('base: "/seo-ops/"');
  const resolved = await resolveConfig({ configFile: "vite.config.ts" }, "build");
  expect(resolved.base).toBe("/seo-ops/");
  expect(packageJson).toContain("vite --config vite.config.ts build");
  expect(nginx).toContain("listen 8080");
  expect(nginx).toContain("location = /seo-ops/healthz");
  expect(docker).toContain("nginx-unprivileged");
  expect(workflow).toContain("npm ci");
  expect(workflow).toContain("chancetop/connexup-seo-ops");
  expect(workflow).toContain("VERSION");
});
