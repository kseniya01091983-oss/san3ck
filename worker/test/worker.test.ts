import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { isAllowedTelegramId } from "../src/access";
import { createSiteLoginUrl, exchangeSiteToken, getSiteSessionTelegramId, hasSiteSession } from "../src/auth";
import { structureTextNote, validateGroundedAnswer } from "../src/ai";
import { claimFailedNoteForRetry, claimTelegramUpdate, createNote, failStalePendingNotes, getNote, getNoteApi, insertAttachment, listNotes, searchNotesForAnswer, updateNote } from "../src/db";
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

  it("publishes stale pending notes without touching another user's notes", async () => {
    await env.DB.prepare("DELETE FROM notes WHERE owner_telegram_id IN (?, ?)").bind(40004, 50005).run();
    const stale = await createNote(env.DB, {
      ownerTelegramId: 40004,
      type: "note",
      title: "Зависшая запись",
      text: "Исходный текст сохранён",
      status: "draft",
      processingStatus: "pending",
    });
    const other = await createNote(env.DB, {
      ownerTelegramId: 50005,
      type: "note",
      title: "Чужая зависшая запись",
      text: "Не изменять",
      status: "draft",
      processingStatus: "pending",
    });
    await env.DB.prepare("UPDATE notes SET created_at = datetime('now', '-3 minutes') WHERE id IN (?, ?)")
      .bind(stale.id, other.id)
      .run();

    expect(await failStalePendingNotes(env.DB, 40004)).toBe(1);
    expect(await getNote(env.DB, 40004, stale.id)).toMatchObject({ status: "published", processing_status: "failed" });
    expect(await getNote(env.DB, 50005, other.id)).toMatchObject({ status: "draft", processing_status: "pending" });
  });

  it("allows only one retry claim for a failed note", async () => {
    const failed = await createNote(env.DB, {
      ownerTelegramId: 60006,
      type: "note",
      title: "Повтор",
      text: "Запустить только один раз",
      processingStatus: "failed",
    });

    expect(await claimFailedNoteForRetry(env.DB, 60006, failed.id)).toBe(true);
    expect(await claimFailedNoteForRetry(env.DB, 60006, failed.id)).toBe(false);
    expect(await claimFailedNoteForRetry(env.DB, 70007, failed.id)).toBe(false);
    expect(await getNote(env.DB, 60006, failed.id)).toMatchObject({ processing_status: "pending" });
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
    const url = await createSiteLoginUrl(env, 10001);
    const exchange = await exchangeSiteToken(new Request(url), env);
    expect(exchange.status).toBe(302);
    const cookie = exchange.headers.get("Set-Cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const sessionCookie = cookie!.split(";", 1)[0];
    expect(await hasSiteSession(new Request("https://fastnotes.test", { headers: { Cookie: sessionCookie } }), env))
      .toBe(true);
    expect(await getSiteSessionTelegramId(new Request("https://fastnotes.test", { headers: { Cookie: sessionCookie } }), env))
      .toBe(10001);
  });

  it("rejects a changed token", async () => {
    const url = new URL(await createSiteLoginUrl(env, 10001));
    const token = url.searchParams.get("token")!;
    url.searchParams.set("token", `${token.slice(0, -1)}x`);
    expect((await exchangeSiteToken(new Request(url), env)).status).toBe(401);
  });

  it("allows the teacher but rejects an unrelated Telegram ID", async () => {
    expect(isAllowedTelegramId(env, 10001)).toBe(true);
    expect(isAllowedTelegramId(env, 126041348)).toBe(true);
    expect(isAllowedTelegramId(env, 999999999)).toBe(false);
    await expect(createSiteLoginUrl(env, 999999999)).rejects.toThrow("не имеет доступа");
  });
});

describe("Worker API", () => {
  it("supports authenticated CRUD routes", async () => {
    const exchange = await exchangeSiteToken(new Request(await createSiteLoginUrl(env, 10001)), env);
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

  it("keeps the teacher's notes separate from the owner's notes", async () => {
    const cookieFor = async (telegramId: number): Promise<string> => {
      const exchange = await exchangeSiteToken(new Request(await createSiteLoginUrl(env, telegramId)), env);
      return String(exchange.headers.get("Set-Cookie")).split(";", 1)[0];
    };
    const ownerCookie = await cookieFor(10001);
    const teacherCookie = await cookieFor(126041348);
    const callAs = (cookie: string, path: string, init: RequestInit = {}) => worker.fetch(
      new Request(`https://fastnotes.test${path}`, {
        ...init,
        headers: { Cookie: cookie, Origin: "https://fastnotes.test", "Content-Type": "application/json", ...init.headers },
      }),
      env,
      createExecutionContext(),
    );

    const createdResponse = await callAs(teacherCookie, "/api/notes", {
      method: "POST",
      body: JSON.stringify({ text: "Тестовая заметка преподавателя", raw: true }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{ id: number }>();

    expect((await callAs(teacherCookie, `/api/notes/${created.id}`)).status).toBe(200);
    expect((await callAs(ownerCookie, `/api/notes/${created.id}`)).status).toBe(404);
    const ownerList = await (await callAs(ownerCookie, "/api/notes?status=all")).json<{ items: Array<{ id: number }> }>();
    expect(ownerList.items.some((note) => note.id === created.id)).toBe(false);
  });
});

describe("Telegram access", () => {
  it("accepts the teacher ID and still rejects an unrelated ID", async () => {
    const sentMessages: Array<Record<string, unknown>> = [];
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentMessages.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, result: {} });
    });
    vi.stubGlobal("fetch", mockFetch);
    const sendUpdate = async (update: Record<string, unknown>) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request("https://fastnotes.test/telegram/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
        },
        body: JSON.stringify(update),
      }), env, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };

    try {
      expect((await sendUpdate({
        update_id: 81001,
        message: { message_id: 1, chat: { id: 126041348 }, from: { id: 126041348 }, text: "/start" },
      })).status).toBe(200);
      expect(String(sentMessages.at(-1)?.text)).toContain("FastNotes");
      expect(String(sentMessages.at(-1)?.text)).not.toContain("Доступ закрыт");

      expect((await sendUpdate({
        update_id: 81002,
        message: { message_id: 2, chat: { id: 999999999 }, from: { id: 999999999 }, text: "/start" },
      })).status).toBe(200);
      expect(String(sentMessages.at(-1)?.text)).toContain("Доступ закрыт");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Telegram processing feedback", () => {
  const sendUpdate = async (update: Record<string, unknown>) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://fastnotes.test/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify(update),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };

  it("acknowledges a saved note immediately and replaces that message after success", async () => {
    const telegramCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.telegram.org")) {
        const method = url.split("/").at(-1) || "";
        const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        telegramCalls.push({ method, payload });
        return Response.json({ ok: true, result: { message_id: 91001 } });
      }
      if (url.includes("openrouter.ai")) {
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          intent: "create_note",
          type: "task",
          title: "Купить молоко",
          summary: "Покупка на завтра",
          text: "Купить молоко завтра",
          tags: ["покупки", "задача"],
          section: "tasks",
        }) } }] });
      }
      return new Response("unexpected request", { status: 500 });
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      expect((await sendUpdate({
        update_id: 82001,
        message: { message_id: 1, chat: { id: 10001 }, from: { id: 10001 }, text: "Запиши купить молоко завтра" },
      })).status).toBe(200);

      const acknowledgement = telegramCalls.find((call) => call.method === "sendMessage");
      const completion = telegramCalls.find((call) => call.method === "editMessageText");
      expect(String(acknowledgement?.payload.text)).toContain("сохранена");
      expect(String(acknowledgement?.payload.text)).toContain("Обрабатываю");
      expect(completion?.payload.message_id).toBe(91001);
      expect(String(completion?.payload.text)).toContain("Купить молоко");
      expect(String(completion?.payload.text)).not.toContain("не смогла её обработать");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the source and shows a retry button when AI processing fails", async () => {
    const telegramCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.telegram.org")) {
        const method = url.split("/").at(-1) || "";
        const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        telegramCalls.push({ method, payload });
        return Response.json({ ok: true, result: { message_id: 92001 } });
      }
      if (url.includes("openrouter.ai")) return new Response("provider unavailable", { status: 503 });
      return new Response("unexpected request", { status: 500 });
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      expect((await sendUpdate({
        update_id: 82002,
        message: { message_id: 2, chat: { id: 10001 }, from: { id: 10001 }, text: "Уникальная заметка при ошибке 82002" },
      })).status).toBe(200);

      const completion = telegramCalls.find((call) => call.method === "editMessageText");
      expect(String(completion?.payload.text)).toContain("Заметка сохранена, но нейросеть не смогла её обработать");
      const keyboard = completion?.payload.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
      expect(keyboard?.inline_keyboard?.flat().some((button) => String(button.callback_data).startsWith("retry:"))).toBe(true);

      const saved = await listNotes(env.DB, 10001, { query: "Уникальная заметка при ошибке 82002", status: null });
      expect(saved.items[0]).toMatchObject({
        text: "Уникальная заметка при ошибке 82002",
        processing_status: "failed",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
