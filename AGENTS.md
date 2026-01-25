# Repository Guidelines

## Project Structure & Module Organization

- `apps/bot/src/` contains the TypeScript bot runtime. Entry point is `apps/bot/src/index.ts`, with core behavior in `apps/bot/src/bot.ts` and shared helpers under `apps/bot/src/lib/`.
- `worker/` contains the Cloudflare Workers entry (`worker/index.ts`) and deployment config (`worker/wrangler.toml`).
- `apps/bot/tests/` holds Vitest suites named `*.test.ts`.
- `apps/bot/config/`, `apps/bot/data/`, and `docs/` store supporting configuration, data, and documentation.

## Build, Test, and Development Commands

- `bun install`: install dependencies.
- `bun dev`: run the bot locally via `tsx` (`apps/bot/src/index.ts`).
- `bun run build`: compile TypeScript to `dist/` using `tsc`.
- `bun run start`: run the compiled build (`dist/index.js`) with source maps.
- `bun run type-check`: TypeScript type checking only.
- `bun run check`: format and lint using Biome (`biome check --write`).
- `bun run test`: run Vitest in CI mode (`vitest run`).

## Coding Style & Naming Conventions

- Formatting and linting are enforced by Biome. Use tabs for indentation and double quotes in TS/JS.
- Keep modules small and focused; add shared utilities in `apps/bot/src/lib/`.
- Test files use the `*.test.ts` suffix and live under `apps/bot/tests/`.

## Testing Guidelines

- Test framework: Vitest (`vitest.config.ts`).
- Tests live under `apps/bot/tests/**` and should follow the `*.test.ts` naming pattern.
- Run all tests with `bun run test` and include coverage changes when relevant.

## Commit & Pull Request Guidelines

- Prefer Conventional Commits: `feat: ...`, `fix: ...`, `test: ...`, `docs: ...`, `chore: ...`, `refactor: ...`.
- Use short, imperative summaries (e.g., `feat: add tool status messages`).
- PRs should include a clear description, testing performed, and any required deployment notes. Link related issues and avoid committing secrets.

## Security & Configuration Tips

- Local configuration lives in `.env` (see `.env.example`). Never commit secrets.
- Cloudflare Workers secrets should be set via `wrangler secret put` and referenced in `worker/wrangler.toml`.

## ExecPlans

When writing complex features or significant refactors, use an ExecPlan (as described in `.agent/PLANS.md`) from design to implementation
