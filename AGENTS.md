# Правила работы с проектом FastNotes

## Назначение

FastNotes — личный «второй мозг»: Telegram-бот и сайт для сохранения, поиска и управления заметками, ссылками, рекомендациями, изображениями и файлами.

## Главные требования

- Сохранять исходную Python-версию проекта и внешний вид сайта, созданные Сашей.
- Новую облачную версию развивать рядом, в папке `worker/`.
- Не удалять `notes.db`, Python-файлы и существующий сайт.
- Не менять ветку `main`; работа ведётся в `cloudflare-migration`.
- Сервис однопользовательский. Все операции проверяют `OWNER_TELEGRAM_ID`.
- Ответы на вопросы формируются только по записям из D1.
- Полный текст страниц, полученный Tavily Extract, в D1 не сохраняется.
- Секреты нельзя записывать в Git, документацию, логи или сообщения.

## Технологии

- Старая версия: Python, aiogram, aiohttp, SQLAlchemy, SQLite.
- Облачная версия: TypeScript, Cloudflare Workers, D1, Worker Static Assets.
- Внешние API: Telegram Bot API, OpenRouter, Tavily Extract.
- Тесты Worker: Vitest и официальный Cloudflare Vitest Plugin.

## Файлы и данные

- `bot/`, `main.py`, `run_site.py`, `migrations/` — исходная Python-версия.
- `site/index.html` — сохраняемый интерфейс FastNotes; допустимы только точечные изменения для нового API и CRUD.
- `notes.db` — исходная база и резервная копия; не изменять миграционными скриптами.
- `worker/` — новая облачная реализация.
- Временный SQL-экспорт SQLite хранить только в `worker/.data/` и не коммитить.
- R2 не используется. Для вложений в D1 хранятся Telegram `file_id`, описание и метаданные; байты остаются в Telegram.
- Основная модель OpenRouter — `z-ai/glm-5.3-flash` только через `deepinfra`, `novita`, `z-ai`, `gmicloud`; затем DeepSeek и бесплатный резерв.

## Команды проверки

```powershell
cd worker
pnpm install
pnpm run typecheck
pnpm run test
pnpm run dev
```

Проверка локальной Python-версии:

```powershell
python tests/test_bot.py
python tests/test_web.py
```

## Правила завершения этапа

- После существенного изменения обновлять `PROJECT_STATUS.md`.
- Проверять тесты, относящиеся к изменённой части.
- Простыми словами сообщать владельцу, что готово и что требуется сделать в кабинете Cloudflare, Telegram, OpenRouter или Tavily.
- Не выполнять развёртывание и не создавать внешние ресурсы без явного разрешения владельца.
