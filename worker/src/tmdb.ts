import type { Env } from "./types";

export type TmdbMediaKind = "movie" | "tv";
export type TmdbMediaHint = TmdbMediaKind | "any";

export interface TmdbSearchItem {
  id: number;
  kind: TmdbMediaKind;
  title: string;
  originalTitle: string;
  year: string;
}

export interface TmdbCard extends TmdbSearchItem {
  overview: string;
  genres: string[];
  voteAverage: number;
  voteCount: number;
  releaseDate: string;
  posterUrl: string | null;
  sourceUrl: string;
}

async function tmdbRequest<T>(env: Env, path: string, params: Record<string, string>): Promise<T> {
  if (!env.TMDB_READ_ACCESS_TOKEN) throw new Error("TMDB_READ_ACCESS_TOKEN не настроен");
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${env.TMDB_READ_ACCESS_TOKEN}`, Accept: "application/json" },
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) throw new Error(`TMDB: HTTP ${response.status}`);
  return response.json<T>();
}

function year(value: unknown): string {
  const match = String(value || "").match(/^\d{4}/);
  return match?.[0] || "год неизвестен";
}

function normalizeSearchItem(value: Record<string, unknown>): TmdbSearchItem | null {
  if (value.media_type !== "movie" && value.media_type !== "tv") return null;
  const kind = value.media_type;
  const title = String((kind === "movie" ? value.title : value.name) || "").trim();
  if (!title || !Number.isSafeInteger(Number(value.id))) return null;
  return {
    id: Number(value.id),
    kind,
    title,
    originalTitle: String((kind === "movie" ? value.original_title : value.original_name) || title),
    year: year(kind === "movie" ? value.release_date : value.first_air_date),
  };
}

export async function searchTmdb(env: Env, query: string, hint: TmdbMediaHint): Promise<TmdbSearchItem[]> {
  const payload = await tmdbRequest<{ results?: Record<string, unknown>[] }>(env, "/search/multi", {
    query,
    language: "ru-RU",
    include_adult: "false",
    page: "1",
  });
  return (payload.results || [])
    .map(normalizeSearchItem)
    .filter((item): item is TmdbSearchItem => Boolean(item && (hint === "any" || item.kind === hint)))
    .slice(0, 3);
}

function normalized(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function unambiguousTmdbResult(results: TmdbSearchItem[], query: string): TmdbSearchItem | null {
  if (results.length === 1) return results[0];
  const exact = results.filter((item) => normalized(item.title) === normalized(query));
  return exact.length === 1 ? exact[0] : null;
}

interface DetailsResponse extends Record<string, unknown> {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  genres?: Array<{ name?: string }>;
  vote_average?: number;
  vote_count?: number;
  poster_path?: string | null;
}

export async function getTmdbCard(env: Env, kind: TmdbMediaKind, id: number): Promise<TmdbCard> {
  const path = `/${kind}/${id}`;
  const ru = await tmdbRequest<DetailsResponse>(env, path, { language: "ru-RU" });
  let overview = String(ru.overview || "").trim();
  if (!overview) {
    const en = await tmdbRequest<DetailsResponse>(env, path, { language: "en-US" });
    overview = String(en.overview || "").trim();
  }
  const releaseDate = String((kind === "movie" ? ru.release_date : ru.first_air_date) || "");
  const posterPath = typeof ru.poster_path === "string" && /^\/[A-Za-z0-9._-]+$/.test(ru.poster_path)
    ? ru.poster_path
    : null;
  return {
    id: Number(ru.id),
    kind,
    title: String((kind === "movie" ? ru.title : ru.name) || "Без названия"),
    originalTitle: String((kind === "movie" ? ru.original_title : ru.original_name) || ""),
    year: year(releaseDate),
    overview: overview || "Описание пока отсутствует.",
    genres: (ru.genres || []).map((genre) => String(genre.name || "").trim()).filter(Boolean),
    voteAverage: Number(ru.vote_average || 0),
    voteCount: Number(ru.vote_count || 0),
    releaseDate,
    posterUrl: posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null,
    sourceUrl: `https://www.themoviedb.org/${kind}/${id}`,
  };
}
