import type { Env } from "./types";
import { truncate } from "./utils";

export interface TavilyExtractResult {
  content: string;
  title: string | null;
  metadata: Record<string, unknown>;
}

export async function extractPage(env: Env, url: string): Promise<TavilyExtractResult> {
  if (!env.TAVILY_API_KEY) throw new Error("TAVILY_API_KEY не настроен");
  const response = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TAVILY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      urls: [url],
      format: "markdown",
      extract_depth: "basic",
      include_images: false,
    }),
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) {
    throw new Error(`Tavily Extract: HTTP ${response.status} ${truncate(await response.text(), 300)}`);
  }
  const payload = (await response.json()) as {
    results?: Array<{
      url?: string;
      title?: string;
      raw_content?: string;
      content?: string;
      images?: unknown[];
      favicon?: string;
    }>;
    failed_results?: Array<{ url?: string; error?: string }>;
    response_time?: number;
  };
  const result = payload.results?.[0];
  const content = result?.raw_content || result?.content || "";
  if (!content.trim()) {
    const reason = payload.failed_results?.[0]?.error || "страница не вернула текст";
    throw new Error(`Tavily Extract: ${reason}`);
  }
  return {
    content,
    title: result?.title || null,
    metadata: {
      extracted_url: result?.url || url,
      tavily_title: result?.title || null,
      favicon: result?.favicon || null,
      response_time: payload.response_time || null,
    },
  };
}
