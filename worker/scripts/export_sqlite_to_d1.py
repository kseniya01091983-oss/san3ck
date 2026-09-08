#!/usr/bin/env python3
"""Экспорт старых заметок FastNotes из SQLite в SQL для Cloudflare D1.

Исходная база всегда открывается в режиме только для чтения. Получившийся SQL
содержит личные заметки и поэтому сохраняется в worker/.data/, исключённой из Git.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any


def sql_value(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def normalize_tags(raw_tags: Any) -> str:
    if raw_tags is None:
        return "[]"
    if isinstance(raw_tags, str):
        try:
            parsed = json.loads(raw_tags)
        except json.JSONDecodeError:
            parsed = [item.strip() for item in raw_tags.split(",") if item.strip()]
    else:
        parsed = raw_tags
    if not isinstance(parsed, list):
        parsed = [str(parsed)]
    tags = [str(item).strip().lstrip("#") for item in parsed if str(item).strip()]
    return json.dumps(tags, ensure_ascii=False)


def title_and_summary(text: str) -> tuple[str, str]:
    compact = " ".join(text.split())
    title = compact[:80] or "Заметка"
    if len(compact) > 80:
        title = title.rstrip() + "…"
    summary = compact[:300]
    if len(compact) > 300:
        summary = summary.rstrip() + "…"
    return title, summary


def normalize_section(value: Any) -> str:
    raw = str(value or "tasks").strip().lower()
    aliases = {
        "игры": "games",
        "кино": "movies",
        "фильмы": "movies",
        "работа": "work",
        "задачи": "tasks",
        "общее": "tasks",
        "технологии": "tech",
    }
    normalized = aliases.get(raw, raw)
    return normalized if normalized in {"games", "movies", "work", "tasks", "tech"} else "tasks"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Экспортирует notes.db в SQL-файл для импорта в Cloudflare D1."
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "notes.db",
        help="Путь к исходной notes.db (по умолчанию корень проекта).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / ".data" / "legacy-notes.sql",
        help="Путь к временному SQL-файлу.",
    )
    parser.add_argument(
        "--owner-id",
        type=int,
        default=None,
        help="Telegram ID владельца; можно задать через OWNER_TELEGRAM_ID.",
    )
    return parser.parse_args()


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args()
    owner_id = args.owner_id
    if owner_id is None:
        raw_owner_id = os.environ.get("OWNER_TELEGRAM_ID", "").strip()
        if not raw_owner_id.isdigit():
            raise SystemExit(
                "Укажите Telegram ID: --owner-id 123456789 или OWNER_TELEGRAM_ID."
            )
        owner_id = int(raw_owner_id)

    source = args.source.resolve()
    output = args.output.resolve()
    if not source.is_file():
        raise SystemExit(f"База не найдена: {source}")
    if source == output:
        raise SystemExit("Исходный и выходной файлы не должны совпадать.")

    connection = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
    connection.execute("PRAGMA query_only = ON")
    connection.row_factory = sqlite3.Row
    try:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(notes)")}
        required = {"id", "text", "tags", "status", "created_at", "updated_at"}
        missing = required - columns
        if missing:
            raise SystemExit("В таблице notes отсутствуют поля: " + ", ".join(sorted(missing)))
        rows = connection.execute("SELECT * FROM notes ORDER BY id").fetchall()
    finally:
        connection.close()

    output.parent.mkdir(parents=True, exist_ok=True)
    lines = ["-- Временный экспорт FastNotes. Не добавлять этот файл в Git."]
    for row in rows:
        text = str(row["text"] or "")
        title, summary = title_and_summary(text)
        tags_json = normalize_tags(row["tags"])
        status = str(row["status"] or "published")
        section = normalize_section(row["section"] if "section" in columns else None)
        metadata_json = json.dumps({"migrated_from": "notes.db"}, ensure_ascii=False)
        values = [
            row["id"],
            owner_id,
            "note",
            title,
            summary,
            text,
            tags_json,
            section,
            status,
            None,
            "ready",
            metadata_json,
            row["created_at"],
            row["updated_at"],
        ]
        lines.append(
            "INSERT INTO notes "
            "(id, owner_telegram_id, type, title, summary, text, tags_json, section, "
            "status, source_url, processing_status, metadata_json, created_at, updated_at) "
            "VALUES (" + ", ".join(sql_value(value) for value in values) + ");"
        )
    lines.append("")
    output.write_text("\n".join(lines), encoding="utf-8")
    print(f"Готово: экспортировано заметок — {len(rows)}")
    print(f"SQL-файл: {output}")
    print("Исходная notes.db открывалась только для чтения и не изменялась.")


if __name__ == "__main__":
    main()
