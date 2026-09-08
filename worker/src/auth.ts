import type { Env } from "./types";
import { isAllowedTelegramId } from "./access";

const COOKIE_NAME = "fastnotes_session";
const LINK_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function base64Url(bytes: ArrayBuffer): string {
  const chars = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(chars).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function verifySignedValue(secret: string, value: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const padded = signature.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (padded.length % 4)) % 4);
  try {
    const bytes = Uint8Array.from(atob(padded + padding), (char) => char.charCodeAt(0));
    return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(value));
  } catch {
    return false;
  }
}

async function createToken(env: Env, telegramId: number, ttlSeconds: number): Promise<string> {
  if (!isAllowedTelegramId(env, telegramId)) throw new Error("Telegram ID не имеет доступа");
  const payload = `${telegramId}.${Math.floor(Date.now() / 1000) + ttlSeconds}`;
  return `${payload}.${await hmac(env.SITE_AUTH_SECRET, payload)}`;
}

async function verifyToken(token: string, env: Env): Promise<number | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rawTelegramId, rawExpires, signature] = parts;
  const telegramId = Number(rawTelegramId);
  if (!Number.isSafeInteger(telegramId) || !isAllowedTelegramId(env, telegramId)) return null;
  if (Number(rawExpires) < Math.floor(Date.now() / 1000)) {
    return null;
  }
  const valid = await verifySignedValue(env.SITE_AUTH_SECRET, `${rawTelegramId}.${rawExpires}`, signature);
  return valid ? telegramId : null;
}

export async function createSiteLoginUrl(env: Env, telegramId: number): Promise<string> {
  const token = await createToken(env, telegramId, LINK_TTL_SECONDS);
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/auth/site?token=${encodeURIComponent(token)}`;
}

export async function exchangeSiteToken(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  const telegramId = await verifyToken(token, env);
  if (!telegramId) {
    return new Response("Ссылка устарела или недействительна. Запросите новую командой /site в Telegram.", {
      status: 401,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const session = await createToken(env, telegramId, SESSION_TTL_SECONDS);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Cache-Control": "no-store",
      "Set-Cookie": `${COOKIE_NAME}=${session}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Strict${secure}`,
    },
  });
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export async function getSiteSessionTelegramId(request: Request, env: Env): Promise<number | null> {
  const token = readCookie(request, COOKIE_NAME);
  return token ? verifyToken(token, env) : null;
}

export async function hasSiteSession(request: Request, env: Env): Promise<boolean> {
  return (await getSiteSessionTelegramId(request, env)) !== null;
}

export function logoutResponse(request: Request): Response {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`,
    },
  });
}

export function isSameOriginMutation(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}
