import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

describe("README deployment contract", () => {
  it("documents the local cookie backend and all six exact permissions", () => {
    expect(readme).toContain("本项目 SEO Ops backend");
    expect(readme).toContain("同源 Cookie");
    expect(readme).toContain("`/api/auth/*`");
    expect(readme).toContain("`/api/seo-ops/*`");
    for (const permission of [
      "seoops.view",
      "seoops.manage",
      "seoops.approve",
      "seoops.execute",
      "seoops.capability.manage",
      "seoops.schedule.manage",
    ]) expect(readme).toContain(`\`${permission}\``);
  });

  it("does not describe browser credentials or Core AI as the public API backend", () => {
    for (const legacyText of ["apiKey", "Bearer", "`/api/auth/me`", "`chat.use`", "转发给 Core AI"]) {
      expect(readme).not.toContain(legacyText);
    }
    expect(readme).toContain("`CORE_AI_BASE_URL`");
    expect(readme).toContain("`CORE_AI_TOKEN`");
    expect(readme).toContain("永不进入浏览器");
  });
});
