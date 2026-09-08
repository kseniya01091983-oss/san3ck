import type { AnswerResult, Env, NoteApi, NoteSection, StructuredNote } from "./types";
import {
  firstLine,
  normalizeSection,
  normalizeTags,
  normalizeType,
  truncate,
} from "./utils";

interface OpenRouterMessage {
  role: "system" | "user";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
}

export type MessageAnalysis =
  | { intent: "create_note"; note: StructuredNote }
  | ({ intent: "answer_question" } & AnswerResult);

const GLM_PROVIDERS = ["deepinfra", "novita", "z-ai", "gmicloud"] as const;
const TEXT_FALLBACK_MODEL = "deepseek/deepseek-v4-flash-0731";
const FREE_FALLBACK_MODEL = "openrouter/free";

function configuredModel(env: Env): string {
  if (!env.OPENROUTER_MODEL || env.OPENROUTER_MODEL === "SET_AFTER_SELECTION") {
    throw new Error("Модель OpenRouter не настроена в переменных Worker");
  }
  return env.OPENROUTER_MODEL;
}

function extractJson(value: string): Record<string, unknown> {
  const clean = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("OpenRouter вернул ответ без JSON");
  return JSON.parse(clean.slice(start, end + 1)) as Record<string, unknown>;
}

async function openRouter(
  env: Env,
  messages: OpenRouterMessage[],
  needsVision = false,
): Promise<Record<string, unknown>> {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY не настроен");
  const attempts: Array<{ model: string; provider?: Record<string, unknown> }> = [
    {
      model: configuredModel(env),
      provider: {
        order: [...GLM_PROVIDERS],
        only: [...GLM_PROVIDERS],
        allow_fallbacks: true,
      },
    },
  ];
  if (!needsVision) attempts.push({ model: TEXT_FALLBACK_MODEL });
  attempts.push({ model: FREE_FALLBACK_MODEL });

  const failures: string[] = [];
  for (const attempt of attempts) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.PUBLIC_BASE_URL,
        "X-Title": "FastNotes Second Brain",
      },
      body: JSON.stringify({
        model: attempt.model,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
        ...(attempt.provider ? { provider: attempt.provider } : {}),
      }),
    });
    if (!response.ok) {
      failures.push(`${attempt.model}: HTTP ${response.status} ${truncate(await response.text(), 180)}`);
      continue;
    }
    try {
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("пустой ответ");
      return extractJson(content);
    } catch (error) {
      failures.push(`${attempt.model}: ${error instanceof Error ? error.message : "неверный ответ"}`);
    }
  }
  throw new Error(`OpenRouter: все разрешённые маршруты недоступны. ${failures.join("; ")}`);
}

function structuredNote(value: Record<string, unknown>, fallbackText: string): StructuredNote {
  const type = normalizeType(value.type, "note");
  const allowedType = ["note", "task", "idea", "recommendation"].includes(type) ? type : "note";
  const title = truncate(String(value.title || firstLine(fallbackText)), 160);
  const summary = truncate(String(value.summary || ""), 800);
  const text = String(value.text || value.enhanced_text || fallbackText).trim();
  return {
    type: allowedType as StructuredNote["type"],
    title,
    summary,
    text,
    tags: normalizeTags(value.tags),
    section: normalizeSection(value.section),
  };
}

function contextForNotes(notes: NoteApi[]): string {
  return notes
    .map(
      (note) =>
        `[ID ${note.id}] ${note.title}\nРаздел: ${note.section}\nОписание: ${note.summary}\nТекст: ${truncate(note.text, 1800)}`,
    )
    .join("\n\n---\n\n");
}

export function validateGroundedAnswer(
  result: Record<string, unknown>,
  candidateNotes: NoteApi[],
): AnswerResult {
  const allowed = new Set(candidateNotes.map((note) => note.id));
  const sourceIds = Array.isArray(result.source_note_ids)
    ? result.source_note_ids.map(Number).filter((id) => Number.isInteger(id) && allowed.has(id))
    : [];
  const answer = truncate(String(result.answer || "").trim(), 3500);
  if (!sourceIds.length || !answer) {
    return {
      answer: "В ваших сохранённых заметках нет информации по этому вопросу.",
      source_note_ids: [],
    };
  }
  return { answer, source_note_ids: [...new Set(sourceIds)] };
}

export async function analyzeTextMessage(
  env: Env,
  text: string,
  candidateNotes: NoteApi[],
  forceQuestion = false,
): Promise<MessageAnalysis> {
  if (forceQuestion && candidateNotes.length === 0) {
    return {
      intent: "answer_question",
      answer: "В ваших сохранённых заметках нет информации по этому вопросу.",
      source_note_ids: [],
    };
  }

  const prompt = `Ты — персональный ассистент FastNotes. Определи, пользователь задаёт вопрос по своей базе или сохраняет новую запись.

Правила:
1. Если force_question=true, intent всегда answer_question.
2. Ответ на вопрос разрешён ТОЛЬКО по контексту ниже. Не добавляй внешние знания и догадки.
3. Для ответа перечисли source_note_ids. Используй только ID из контекста. Если подтверждения нет — верни точную фразу: «В ваших сохранённых заметках нет информации по этому вопросу.» и пустой массив.
4. Для новой записи создай чистый заголовок, краткое описание, полезный структурированный текст, 2–6 тегов и один раздел.
5. Тип новой текстовой записи: note, task, idea или recommendation.
6. Раздел: games, movies, work, tasks или tech.
7. Без эмодзи и без выдуманных фактов.

Верни только JSON одного из форматов:
{"intent":"answer_question","answer":"...","source_note_ids":[1,2]}
{"intent":"create_note","type":"note|task|idea|recommendation","title":"...","summary":"...","text":"...","tags":["..."],"section":"games|movies|work|tasks|tech"}

force_question=${forceQuestion ? "true" : "false"}

КОНТЕКСТ ИЗ D1:
${candidateNotes.length ? contextForNotes(candidateNotes) : "(подходящих записей нет)"}`;

  const result = await openRouter(
    env,
    [
      { role: "system", content: prompt },
      { role: "user", content: text },
    ],
  );

  if (result.intent === "answer_question" || forceQuestion) {
    return { intent: "answer_question", ...validateGroundedAnswer(result, candidateNotes) };
  }

  return { intent: "create_note", note: structuredNote(result, text) };
}

export async function structureTextNote(env: Env, text: string): Promise<StructuredNote> {
  const prompt = `Преобразуй текст в запись FastNotes. Верни только JSON:
{"type":"note|task|idea|recommendation","title":"...","summary":"...","text":"...","tags":["..."],"section":"games|movies|work|tasks|tech"}

Сохрани смысл пользователя. Не добавляй факты. Заголовок до 160 символов, описание до 800 символов, 2–6 коротких тегов. Без эмодзи.`;
  const result = await openRouter(
    env,
    [
      { role: "system", content: prompt },
      { role: "user", content: text },
    ],
  );
  return structuredNote(result, text);
}

export async function summarizeExtractedLink(
  env: Env,
  url: string,
  caption: string,
  extractedContent: string,
): Promise<Omit<StructuredNote, "type">> {
  const prompt = `Создай карточку ссылки для личной базы FastNotes. Верни только JSON:
{"title":"...","summary":"...","text":"...","tags":["..."],"section":"games|movies|work|tasks|tech"}

Требования: краткий достоверный пересказ по извлечённому содержимому, без внешних фактов. text должен содержать заголовок, краткий пересказ и 3–5 ключевых пунктов. Не копируй большие фрагменты дословно. Без эмодзи.`;
  const result = await openRouter(
    env,
    [
      { role: "system", content: prompt },
      {
        role: "user",
        content: `URL: ${url}\nПодпись пользователя: ${caption || "(нет)"}\n\nСодержимое Tavily:\n${truncate(extractedContent, 45_000)}`,
      },
    ],
  );
  const parsed = structuredNote(result, caption || url);
  return {
    title: parsed.title,
    summary: parsed.summary,
    text: parsed.text,
    tags: parsed.tags,
    section: parsed.section,
  };
}

export async function describeImage(
  env: Env,
  dataUrl: string,
  caption: string,
): Promise<Omit<StructuredNote, "type">> {
  const prompt = `Опиши изображение для личной базы FastNotes. Верни только JSON:
{"title":"...","summary":"...","text":"...","tags":["..."],"section":"games|movies|work|tasks|tech"}

Опиши только то, что действительно видно. Учитывай подпись пользователя. Не идентифицируй неизвестных людей. Без эмодзи.`;
  const result = await openRouter(
    env,
    [
      { role: "system", content: prompt },
      {
        role: "user",
        content: [
          { type: "text", text: `Подпись пользователя: ${caption || "(нет)"}` },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    true,
  );
  const parsed = structuredNote(result, caption || "Изображение");
  return {
    title: parsed.title,
    summary: parsed.summary,
    text: parsed.text,
    tags: parsed.tags,
    section: parsed.section,
  };
}
