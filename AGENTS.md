# Repository Guidelines

## Project Structure & Module Organization

- `apps/bot/src/` contains the TypeScript bot runtime. Entry point is `apps/bot/src/index.ts`, with core behavior in `apps/bot/src/bot.ts` and shared helpers under `apps/bot/src/lib/`.
- `apps/admin/` contains the Next.js admin dashboard (Gateway UI).
- `apps/worker/` contains Worker-side tests and tooling (Vitest config lives here).
- `worker/` contains the Cloudflare Workers entry (`worker/index.ts`) and deployment config (`worker/wrangler.toml`).
- `apps/bot/tests/` holds Vitest suites named `*.test.ts`.
- `apps/bot/config/`, `apps/bot/data/`, and `docs/` store supporting configuration, data, and documentation.

## Build, Test, and Development Commands

- `bun install`: install dependencies.
- `bun run dev`: run all dev tasks via Turborepo.
- `bun run dev:admin`: run only the admin app dev server.
- `bun run dev:bot`: run only the bot locally via `tsx` (`apps/bot/src/index.ts`).
- `bun run dev:worker`: run only the worker dev server locally.
- `bun run build`: build all packages via Turborepo.
- `bun run test`: run all tests via Turborepo.
- `bun run check`: format and lint using Biome (`biome check --write`).
- `bun run type-check`: TypeScript type checking only.

## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:
1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes

## Coding Style & Naming Conventions

- Formatting and linting are enforced by Biome. Use tabs for indentation and double quotes in TS/JS.
- Keep modules small and focused; add shared utilities in `apps/bot/src/lib/`.
- Test files use the `*.test.ts` suffix and live under `apps/bot/tests/`.
- Use ArkRegex (`regex(...)` from `arkregex`) instead of raw regex literals or `new RegExp()` in TypeScript code.

## Testing Guidelines

- Test framework: Vitest (`vitest.config.ts`).
- Tests live under `apps/bot/tests/**` and `worker/tests/**` and should follow the `*.test.ts` naming pattern.
- Run all tests with `bun run test` and include coverage changes when relevant.

## Commit & Pull Request Guidelines

- Prefer Conventional Commits: `feat: ...`, `fix: ...`, `test: ...`, `docs: ...`, `chore: ...`, `refactor: ...`.
- Use short, imperative summaries (e.g., `feat: add tool status messages`).
- PRs should include a clear description, testing performed, and any required deployment notes. Link related issues and avoid committing secrets.

## Security & Configuration Tips

- Local configuration lives in `.env` (see `.env.example`). Never commit secrets.
- Cloudflare Workers secrets should be set via `wrangler secret put` and referenced in `worker/wrangler.toml`.
 - Use `worker/.dev.vars` for local Worker-only env; keep a `worker/.dev.vars.example` in git.

## Admin Chat

- Admin chat connects via gateway WebSocket (`/gateway`) and streams responses.
- It shares the same bot pipeline as Telegram but does not persist history.

## ExecPlans

When writing complex features or significant refactors, use an ExecPlan (as described in `.agent/PLANS.md`) from design to implementation
