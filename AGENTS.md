# Notion Calendar Sync Instructions

## Scope

Applies to the Notion-to-Google Calendar sync service.

The production target is the Cloudflare Worker configured in `wrangler.toml`. The legacy Flask/PythonAnywhere implementation lives in `neinron/python-notion-googlecalendar-sync`.

## Commands

- Install Worker dependencies: `npm install`
- Typecheck Worker: `npm run typecheck`
- Run Worker unit tests: `npm run test:worker`
- Deploy Worker: `npm run deploy:worker`
- Apply remote D1 migrations: `npm run d1:migrate:remote`

## Working Notes

- Runtime configuration lives in `.env`.
- Worker production secrets must be set with `wrangler secret put`; do not commit secrets.
- Cloudflare D1 is fresh production state; do not import legacy SQLite state unless explicitly requested.
- Notion is the source of truth when Notion and Google both changed since the last sync.
- Keep Cloudflare deployment notes in `README.md`; keep legacy PythonAnywhere notes in the separate legacy repo.
