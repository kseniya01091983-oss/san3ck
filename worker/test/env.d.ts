import type { Env as FastNotesEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env extends FastNotesEnv {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
  }
}

export {};
