# Gateway CLI Parity (Status/Health/Call)

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan must be maintained in accordance with `.agent/PLANS.md`.

## Purpose / Big Picture

After this change, a local operator can run CLI commands similar to `clawdbot gateway status/health/call` against the Omni gateway WebSocket. This enables quick checks without the UI. Success is visible when CLI commands connect to the gateway and return JSON responses that match the gateway RPC payloads.

## Progress

- [ ] (2026-01-25T00:00Z) Define CLI command surface and argument parsing.
- [ ] (2026-01-25T00:00Z) Implement a WebSocket CLI client for gateway RPC.
- [ ] (2026-01-25T00:00Z) Add CLI commands: health, status, call.
- [ ] (2026-01-25T00:00Z) Validate local CLI against the running gateway.

## Surprises & Discoveries

- Observation: None yet.
  Evidence: N/A.

## Decision Log

- Decision: Implement CLI as a Bun/Node script in `apps/bot/scripts/` to reuse repo tooling.
  Rationale: Keeps dependencies local and allows `bun run` execution.
  Date/Author: 2026-01-25 / Codex

## Outcomes & Retrospective

- Pending. This section will be updated after milestones complete.

## Context and Orientation

The gateway WebSocket endpoint is implemented in `worker/index.ts` at `/gateway`. The Admin UI uses `apps/admin/lib/gateway-client.ts` to call RPC methods. The CLI should reuse the same protocol. The repository already uses Bun and scripts in `apps/bot/scripts/` for tooling; this is a natural home for a CLI.

## Plan of Work

Create a new CLI entry point (e.g., `apps/bot/scripts/gateway-cli.ts`) with a small argument parser supporting:

- `gateway health` → call `connect` and return `ok` if successful.
- `gateway status` → call `connect` and print the `status` payload.
- `gateway call <method> [--params <json>]` → call an arbitrary RPC method and print the payload.

Support flags:
- `--url <ws-url>` or `--url <http-url>` (convert http(s) to ws(s) and append `/gateway`)
- `--token <token>`
- `--json` output

Wire the CLI into `apps/bot/package.json` scripts (e.g., `gateway`).

## Concrete Steps

1) Implement `gateway-cli.ts` with argument parsing and WebSocket RPC logic.
2) Add script in `apps/bot/package.json` (e.g., `"gateway": "tsx scripts/gateway-cli.ts"`).
3) Add a short usage section to `docs/admin-ui.md` or a new `docs/gateway-cli.md`.

## Validation and Acceptance

Run:

    cd /Users/murad-pc/Documents/Github/omni/apps/bot
    bun run gateway -- health --url http://127.0.0.1:8787 --token <token>

Expect a success message or JSON. Then:

    bun run gateway -- status --url http://127.0.0.1:8787 --token <token> --json

Expect JSON with `serviceName`, `version`, etc.

## Idempotence and Recovery

CLI changes are additive. If the gateway is unreachable, return clear non-zero exit codes. Removing the script restores the prior state.

## Artifacts and Notes

Example output:

    {"ok":true,"status":{"serviceName":"omni","version":"dev"}}

## Interfaces and Dependencies

Define a minimal RPC client in the CLI with:

    async function rpc(method: string, params?: unknown): Promise<unknown>

Use the same `req/res` frame structure as the Admin UI client.

## Plan Revision Notes

Initial creation of the ExecPlan for CLI parity.
