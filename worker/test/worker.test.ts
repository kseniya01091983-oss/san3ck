import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createSiteLoginUrl, exchangeSiteToken, hasSiteSession } from "../src/auth";
import { structureTextNote, validateGroundedAnswer } from "../src/ai";
import { claimTelegramUpdate, createNote, getNoteApi, insertAttachment, listNotes, searchNotesForAnswer, updateNote } from "../src/db";
import { extractFirstUrl, normalizeTags } from "../src/utils";

describe("FastNotes helpers", () => {
  it("normalizes tags without duplicates", () => {
    expect(normalizeTags(["#Проект", "проект", "  AI ", ""])).toEqual(["проект", "ai"]);
  });

  it("extracts the first URL and removes trailing punctuation", () => {
    expect(extractFirstUrl("Сохрани https://example.com/page). И ещё https://second.test"))
      .toBe("https://example.com/page");
  });
});

describe("D1 notes", () => {
  it("creates, finds, updates and filters a note", async () => {
    const created = await createNote(env.DB, {
      ownerTelegramId: 10001,
      type: "task",
      title: "Проект FastNotes",
      summary: "Перенести проект в Cloudflare",
      text: "Настроить Worker и базу D1",
      tags: ["cloudflare", "проект"],
      section: "tech",
    });

    const search = await searchNotesForAnswer(env.DB, 10001, "Cloudflare");
    expect(search.map((note) => note.id)).toContain(created.id);

    await updateNote(env.DB, 10001, created.id, { status: "hidden" });
    const visible = await listNotes(env.DB, 10001, { status: "published" });
    expect(visible.items.map((note) => note.id)).not.toContain(created.id);
  });

  it("never returns another owner's records", async () => {
    await createNote(env.DB, {
      ownerTelegramId: 20002,
      type: "note",
      title: "Чужая запись",
      text: "Эта запись не должна быть видна",
    });
    const result = await listNotes(env.DB, 10001, { status: null });
    expect(result.items.some((note) => note.title === "Чужая запись")).toBe(false);
  });

  it("claims every Telegram update only once", async () => {
    expect(await claimTelegramUpdate(env.DB, 70001)).toBe(true);
    expect(await claimTelegramUpdate(env.DB, 70001)).toBe(false);
  });

  it("stores Telegram file metadata without R2", async () => {
    const note = await createNote(env.DB, {
      ownerTelegramId: 10001,
      type: "image",
      title: "Фото",
      text: "Описание фотографии",
    });
    const attachment = await insertAttachment(env.DB, {
      note_id: note.id,
      owner_telegram_id: 10001,
      telegram_file_id: "telegram-file-id",
      telegram_file_unique_id: "telegram-unique-id",
      file_name: "photo.jpg",
      mime_type: "image/jpeg",
      size_bytes: 1234,
      width: 100,
      height: 80,
    });
    expect(attachment.telegram_file_id).toBe("telegram-file-id");
    expect("r2_key" in attachment).toBe(false);
  });

  it("rejects an AI answer that cites a note outside D1 search results", async () => {
    const row = await createNote(env.DB, {
      ownerTelegramId: 30003,
      type: "note",
      title: "Источник",
      text: "Проверенный текст",
    });
    const candidate = await getNoteApi(env.DB, 30003, row.id);
    expect(candidate).not.toBeNull();
    expect(validateGroundedAnswer({ answer: "Выдуманный ответ", source_note_ids: [999999] }, [candidate!]))
      .toEqual({
        answer: "В ваших сохранённых заметках нет информации по этому вопросу.",
        source_note_ids: [],
      });
  });
});

describe("OpenRouter routing", () => {
  it("uses only the selected GLM providers in the requested order", async () => {
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("z-ai/glm-5.3-flash");
      expect(body.provider.only).toEqual(["deepinfra", "novita", "z-ai", "gmicloud"]);
      expect(body.provider.order).toEqual(["deepinfra", "novita", "z-ai", "gmicloud"]);
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        type: "note", title: "Тест", summary: "Тест", text: "Тест", tags: ["тест"], section: "tech",
      }) } }] });
    });
    vi.stubGlobal("fetch", mockFetch);
    try {
      await structureTextNote(env, "Тест");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to DeepSeek only after the allowed GLM routes fail", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) return new Response("provider unavailable", { status: 503 });
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        type: "note", title: "Резерв", summary: "Резерв", text: "Резерв", tags: [], section: "tech",
      }) } }] });
    });
    vi.stubGlobal("fetch", mockFetch);
    try {
      await structureTextNote(env, "Резерв");
      expect(bodies[1].model).toBe("deepseek/deepseek-v4-flash-0731");
      expect(bodies[1]).not.toHaveProperty("provider");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("site login", () => {
  it("exchanges a temporary link for a valid HttpOnly session", async () => {
    const url = await createSiteLoginUrl(env);
    const exchange = await exchangeSiteToken(new Request(url), env);
    expect(exchange.status).toBe(302);
    const cookie = exchange.headers.get("Set-Cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const sessionCookie = cookie!.split(";", 1)[0];
    expect(await hasSiteSession(new Request("https://fastnotes.test", { headers: { Cookie: sessionCookie } }), env))
      .toBe(true);
  });

  it("rejects a changed token", async () => {
    const url = new URL(await createSiteLoginUrl(env));
    const token = url.searchParams.get("token")!;
    url.searchParams.set("token", `${token.slice(0, -1)}x`);
    expect((await exchangeSiteToken(new Request(url), env)).status).toBe(401);
  });
});

describe("Worker API", () => {
  it("supports authenticated CRUD routes", async () => {
    const exchange = await exchangeSiteToken(new Request(await createSiteLoginUrl(env)), env);
    const setCookie = exchange.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    const cookie = String(setCookie).split(";", 1)[0];
    const headers = { Cookie: cookie, Origin: "https://fastnotes.test", "Content-Type": "application/json" };
    const call = (path: string, init: RequestInit = {}) => worker.fetch(
      new Request(`https://fastnotes.test${path}`, { ...init, headers: { ...headers, ...init.headers } }),
      env,
      createExecutionContext(),
    );

    const createdResponse = await call("/api/notes", {
      method: "POST",
      body: JSON.stringify({ text: "API заметка", raw: true, section: "tech" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{ id: number }>();

    const readResponse = await call(`/api/notes/${created.id}`);
    expect(readResponse.status).toBe(200);
    expect((await readResponse.json<{ text: string }>()).text).toBe("API заметка");

    const updateResponse = await call(`/api/notes/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({ text: "Обновлённая API заметка", status: "hidden" }),
    });
    expect(updateResponse.status).toBe(200);
    expect((await updateResponse.json<{ status: string }>()).status).toBe("hidden");

    expect((await call(`/api/notes/${created.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await call(`/api/notes/${created.id}`)).status).toBe(404);
  });

  it("rejects API requests without a Telegram-created session", async () => {
    const response = await worker.fetch(
      new Request("https://fastnotes.test/api/notes"),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(401);
  });
});
