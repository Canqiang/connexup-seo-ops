/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/seo-ops/",
  plugins: [react()],
  server: {
    proxy: {
      // Local dev: forward API calls to the seo-ops backend (server/).
      "/api": "http://localhost:8787"
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true
  }
});
