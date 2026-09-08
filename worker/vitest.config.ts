import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(directory, "migrations")),
          OWNER_TELEGRAM_ID: "10001",
          PUBLIC_BASE_URL: "https://fastnotes.test",
          TELEGRAM_BOT_TOKEN: "test-token",
          TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
          OPENROUTER_API_KEY: "test-openrouter-key",
          TAVILY_API_KEY: "test-tavily-key",
          SITE_AUTH_SECRET: "test-site-secret-with-enough-entropy",
          OPENROUTER_MODEL: "z-ai/glm-5.3-flash",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
