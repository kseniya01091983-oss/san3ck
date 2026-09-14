import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { analyzeTextMessage } from "../src/ai";
import {
  createNote,
  findExternalNote,
  getConversationState,
  getNote,
  setConversationState,
} from "../src/db";
import { getTmdbCard, searchTmdb, unambiguousTmdbResult } from "../src/tmdb";
import type { Env } from "../src/types";
import {
  deleteNoteVector,
  reindexOwner,
  searchRagNotes,
  syncNoteVector,
  vectorNamespace,
  vectorText,
} from "../src/upstash";

function integrationEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    UPSTASH_VECTOR_REST_URL: "https://vector.example.test",
    UPSTASH_VECTOR_REST_TOKEN: "upstash-test-token",
    TMDB_READ_ACCESS_TOKEN: "tmdb-test-token",
    ...overrides,
  };
}

describe("Upstash RAG", () => {
  it("derives isolated namespaces without exposing Telegram IDs", async () => {
    const owner = await vectorNamespace(env, 10001);
    const teacher = await vectorNamespace(env, 126041348);
    expect(owner).not.toBe(teacher);
    expect(owner).not.toContain("10001");
    expect(teacher).not.toContain("126041348");
  });

  it("sends only title, summary and tags to Upstash", async () => {
    const note = await createNote(env.DB, {
      ownerTelegramId: 71001,
      type: "note",
      title: "Кодовое название",
      summary: "Короткое описание",
      text: "СЕКРЕТНЫЙ ПОЛНЫЙ ТЕКСТ НЕ ДОЛЖЕН УЙТИ",
      tags: ["проект"],
    });
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body || "") });
      return Response.json({ result: "Success" });
    }));
    try {
      expect(vectorText(note)).not.toContain("СЕКРЕТНЫЙ ПОЛНЫЙ ТЕКСТ");
      expect(await syncNoteVector(integrationEnv(), note)).toBe(true);
      expect(calls[0].url).toContain("/upsert-data/u_");
      expect(calls[0].body).toContain("Кодовое название");
      expect(calls[0].body).toContain("Короткое описание");
      expect(calls[0].body).toContain("проект");
      expect(calls[0].body).not.toContain("СЕКРЕТНЫЙ ПОЛНЫЙ ТЕКСТ");
      expect(await getNote(env.DB, 71001, note.id)).toMatchObject({ vector_status: "synced" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("merges semantic results with D1 FTS and rejects another owner's stale ID", async () => {
    const semantic = await createNote(env.DB, {
      ownerTelegramId: 72001,
      type: "note",
      title: "Поездка к морю",
      summary: "Отдых на побережье",
      text: "Выбрали небольшой дом у воды",
      tags: ["отпуск"],
    });
    const lexical = await createNote(env.DB, {
      ownerTelegramId: 72001,
      type: "note",
      title: "Стоматолог",
      summary: "Запись к врачу",
      text: "Приём у стоматолога во вторник",
    });
    const foreign = await createNote(env.DB, {
      ownerTelegramId: 72002,
      type: "note",
      title: "Чужая запись",
      text: "Не показывать",
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      result: [
        { id: String(semantic.id), score: 0.9 },
        { id: String(foreign.id), score: 0.8 },
        { id: "999999", score: 0.7 },
      ],
    })));
    try {
      const result = await searchRagNotes(integrationEnv(), 72001, "стоматолог");
      expect(result.map((note) => note.id)).toEqual([semantic.id, lexical.id]);
      expect(result.map((note) => note.id)).not.toContain(foreign.id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to D1 FTS when Upstash is unavailable", async () => {
    const note = await createNote(env.DB, {
      ownerTelegramId: 73001,
      type: "note",
      title: "Рецепт пирога",
      text: "Яблочный пирог с корицей",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    try {
      const result = await searchRagNotes(integrationEnv(), 73001, "пирог");
      expect(result.map((item) => item.id)).toContain(note.id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deletes vectors by ID and rebuilds only the current owner's namespace", async () => {
    const row = await createNote(env.DB, {
      ownerTelegramId: 74001,
      type: "note",
      title: "Векторная запись",
      summary: "Для переиндексации",
      text: "Полный закрытый текст",
      tags: ["rag"],
    });
    await createNote(env.DB, {
      ownerTelegramId: 74002,
      type: "note",
      title: "Чужой namespace",
      text: "Не индексировать вместе",
    });
    const calls: Array<{ url: string; method: string; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: String(init?.method), body: String(init?.body || "") });
      return Response.json({ result: "Success" });
    }));
    try {
      const testEnv = integrationEnv();
      await deleteNoteVector(testEnv, 74001, row.id);
      expect(calls[0]).toMatchObject({ method: "DELETE" });
      expect(calls[0].body).toContain(String(row.id));
      expect(await reindexOwner(testEnv, 74001)).toBe(1);
      expect(calls[1].url).toContain("/reset/u_");
      expect(calls[2].body).not.toContain("Полный закрытый текст");
      expect(calls[2].body).not.toContain("Чужой namespace");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("creates the first namespace when reset reports that it does not exist yet", async () => {
    await createNote(env.DB, {
      ownerTelegramId: 74501,
      type: "note",
      title: "Первая запись namespace",
      text: "Создать namespace первым пакетным upsert",
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/reset/")) return new Response("not found", { status: 404 });
      return Response.json({ result: "Success" });
    }));
    try {
      expect(await reindexOwner(integrationEnv(), 74501)).toBe(1);
      expect(calls[0]).toContain("/reset/u_");
      expect(calls[1]).toContain("/upsert-data/u_");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("TMDB integration", () => {
  it("filters people and keeps up to three movies or series", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/search/multi");
      expect(String(input)).toContain("language=ru-RU");
      expect(String(input)).toContain("include_adult=false");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tmdb-test-token");
      return Response.json({ results: [
        { id: 1, media_type: "person", name: "Актёр" },
        { id: 2, media_type: "movie", title: "Шерлок Холмс", original_title: "Sherlock Holmes", release_date: "2009-12-23" },
        { id: 3, media_type: "tv", name: "Шерлок", original_name: "Sherlock", first_air_date: "2010-07-25" },
      ] });
    }));
    try {
      const result = await searchTmdb(integrationEnv(), "Шерлок", "any");
      expect(result).toHaveLength(2);
      expect(result.map((item) => item.kind)).toEqual(["movie", "tv"]);
      expect(unambiguousTmdbResult(result, "Шерлок")?.id).toBe(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses English overview when Russian description is empty", async () => {
    const languages: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      languages.push(url.searchParams.get("language") || "");
      return Response.json({
        id: 157336,
        title: "Интерстеллар",
        original_title: "Interstellar",
        overview: url.searchParams.get("language") === "ru-RU" ? "" : "English overview",
        release_date: "2014-11-05",
        genres: [{ name: "Фантастика" }],
        vote_average: 8.5,
        vote_count: 37000,
        poster_path: "/poster.jpg",
      });
    }));
    try {
      const card = await getTmdbCard(integrationEnv(), "movie", 157336);
      expect(languages).toEqual(["ru-RU", "en-US"]);
      expect(card.overview).toBe("English overview");
      expect(card.posterUrl).toBe("https://image.tmdb.org/t/p/w500/poster.jpg");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stores external metadata and prevents a duplicate for the same owner", async () => {
    const input = {
      ownerTelegramId: 75001,
      type: "recommendation" as const,
      title: "Интерстеллар",
      text: "Фильм",
      section: "movies" as const,
      externalProvider: "tmdb",
      externalKind: "movie",
      externalId: "157336",
      metadata: { tmdb: { id: 157336, posterUrl: null } },
    };
    const first = await createNote(env.DB, input);
    await expect(createNote(env.DB, input)).rejects.toThrow();
    expect(await findExternalNote(env.DB, 75001, "tmdb", "movie", "157336")).toMatchObject({ id: first.id });
    const isolated = await createNote(env.DB, { ...input, ownerTelegramId: 75002 });
    expect(isolated.id).not.toBe(first.id);
  });

  it("keeps a TMDB preview payload in conversation state", async () => {
    await setConversationState(env.DB, 76001, "tmdb_confirm", null, 30, {
      card: { id: 42, kind: "movie", title: "Карточка" },
    });
    expect(await getConversationState(env.DB, 76001)).toMatchObject({
      action: "tmdb_confirm",
      payload: { card: { id: 42, kind: "movie", title: "Карточка" } },
    });
  });

  it("recognizes the media_lookup AI intent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({
      intent: "media_lookup",
      query: "Интерстеллар",
      media_type: "movie",
    }) } }] })));
    try {
      await expect(analyzeTextMessage(env, "Хочу посмотреть Интерстеллар", [])).resolves.toEqual({
        intent: "media_lookup",
        query: "Интерстеллар",
        media_type: "movie",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("saves a Telegram movie only after confirmation and ignores a second press", async () => {
    const testEnv = integrationEnv();
    const telegramCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("vector.example.test")) {
        return url.includes("query-data") ? Response.json({ result: [] }) : Response.json({ result: "Success" });
      }
      if (url.includes("openrouter.ai")) {
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          intent: "media_lookup",
          query: "Интерстеллар",
          media_type: "movie",
        }) } }] });
      }
      if (url.includes("api.themoviedb.org/3/search/multi")) {
        return Response.json({ results: [{
          id: 157336,
          media_type: "movie",
          title: "Интерстеллар",
          original_title: "Interstellar",
          release_date: "2014-11-05",
        }] });
      }
      if (url.includes("api.themoviedb.org/3/movie/157336")) {
        return Response.json({
          id: 157336,
          title: "Интерстеллар",
          original_title: "Interstellar",
          overview: "Путешествие к звёздам.",
          release_date: "2014-11-05",
          genres: [{ name: "Фантастика" }],
          vote_average: 8.5,
          vote_count: 37000,
          poster_path: "/poster.jpg",
        });
      }
      if (url.includes("api.telegram.org")) {
        const method = url.split("/").at(-1) || "";
        const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        telegramCalls.push({ method, payload });
        return Response.json({ ok: true, result: { message_id: 99001 } });
      }
      return new Response("unexpected request", { status: 500 });
    }));

    const sendUpdate = async (update: Record<string, unknown>) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request("https://fastnotes.test/telegram/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
        },
        body: JSON.stringify(update),
      }), testEnv, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };

    try {
      await sendUpdate({
        update_id: 99001,
        message: { message_id: 1, chat: { id: 10001 }, from: { id: 10001 }, text: "Хочу посмотреть Интерстеллар" },
      });
      expect(await findExternalNote(env.DB, 10001, "tmdb", "movie", "157336")).toBeNull();
      expect(await getConversationState(env.DB, 10001)).toMatchObject({ action: "tmdb_confirm" });
      expect(telegramCalls.some((call) => call.method === "sendPhoto")).toBe(true);

      await sendUpdate({
        update_id: 99002,
        callback_query: {
          id: "save-movie",
          from: { id: 10001 },
          message: { message_id: 2, chat: { id: 10001 } },
          data: "tmdb_save",
        },
      });
      const saved = await findExternalNote(env.DB, 10001, "tmdb", "movie", "157336");
      expect(saved).toMatchObject({ type: "recommendation", section: "movies", title: "Интерстеллар" });

      await sendUpdate({
        update_id: 99003,
        callback_query: {
          id: "save-movie-again",
          from: { id: 10001 },
          message: { message_id: 3, chat: { id: 10001 } },
          data: "tmdb_save",
        },
      });
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM notes WHERE owner_telegram_id = ? AND external_provider = 'tmdb' AND external_kind = 'movie' AND external_id = '157336'",
      ).bind(10001).first<{ total: number }>();
      expect(Number(count?.total)).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
