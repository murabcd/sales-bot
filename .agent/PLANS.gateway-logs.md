# Gateway Logs UI (Local Parity)

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan must be maintained in accordance with `.agent/PLANS.md`.

## Purpose / Big Picture

After this change, the Admin UI will include a Logs page that streams recent gateway events in near real-time, similar to Clawdbot’s log tail. Operators can open the Logs page, see the latest gateway requests/responses, and verify that plugins or cron actions are firing without opening the Worker console. Success is visible when new gateway events appear live while exercising the bot/admin UI.

## Progress

- [ ] (2026-01-25T00:00Z) Define a gateway log event schema and storage plan for local dev.
- [ ] (2026-01-25T00:00Z) Implement a log buffer Durable Object and write gateway events into it.
- [ ] (2026-01-25T00:00Z) Add WebSocket RPC methods for log tailing.
- [ ] (2026-01-25T00:00Z) Add Logs page in the Admin UI and live tail UI.
- [ ] (2026-01-25T00:00Z) Validate live log tailing end-to-end.

## Surprises & Discoveries

- Observation: None yet.
  Evidence: N/A.

## Decision Log

- Decision: Use a Durable Object ring buffer for logs to avoid external databases.
  Rationale: Matches local parity goals and keeps state in the Worker with no extra infra.
  Date/Author: 2026-01-25 / Codex

## Outcomes & Retrospective

- Pending. This section will be updated after milestones complete.

## Context and Orientation

The gateway is implemented in `worker/index.ts`, with WebSocket methods and HTTP admin endpoints. Gateway plugins (e.g. the logger plugin in `apps/bot/src/lib/gateway/plugins.ts`) already emit JSON logs to `console.log`. The Admin UI lives in `apps/admin`, with a sidebar layout and WebSocket client. To add a Logs page, the gateway needs to store recent log entries and expose a tail API over WebSocket; the UI will render and update a log feed.

## Plan of Work

Define a minimal log event shape: timestamp, route, path, method, status, duration, and message. Create a new Durable Object (e.g., `GatewayLogsDO`) that stores a fixed-size ring buffer of log events. Update the gateway’s logging hook (or add explicit log writes around requests) to append to the buffer. Expose WebSocket RPC methods:

- `logs.tail` with params `{ sinceMs?: number, limit?: number }` returning recent events.
- Optionally `logs.subscribe` to push new events to connected clients (simple push, or poll via `logs.tail`).

Add a new UI route `apps/admin/app/(app)/logs/page.tsx` that connects to the gateway, calls `logs.tail`, and updates the list on an interval (e.g., every 1–2 seconds). Use existing UI components (`Card`, `Table`, `Badge`, `ScrollArea`) to render a log feed.

## Concrete Steps

1) Add `GatewayLogsDO` and bind it in `worker/wrangler.toml`. Update DO migrations.
2) Add log append helper in `worker/index.ts` and call it for:
   - admin requests (status, cron.run)
   - telegram updates (accepted/blocked)
   - gateway WebSocket requests
3) Add WebSocket RPC handlers for `logs.tail`.
4) Add Admin UI Logs page and sidebar link.

## Validation and Acceptance

Start Worker and Admin UI. Open Logs page, then:
- Refresh the Overview page: a log line appears.
- Run “Run report”: a log line appears.
- Send a Telegram update: a log line appears.

Logs should update without page reload.

## Idempotence and Recovery

All steps are additive. If the log stream is too noisy, disable or reduce buffer size; no data migration is required. If the DO fails, logs fall back to console only.

## Artifacts and Notes

Example log event payload:

    {"ts": 1737780000000, "route": "admin", "path": "/admin/status", "method": "GET", "status": 200, "durationMs": 12, "message": "gateway_response"}

## Interfaces and Dependencies

Add a new DO:

    class GatewayLogsDO implements DurableObject { ... }

Expose a WebSocket method:

    logs.tail(params?: { sinceMs?: number; limit?: number }): { events: LogEvent[] }

Use `apps/admin/lib/gateway-client.ts` to add:

    logsTail(params?: { sinceMs?: number; limit?: number }): Promise<{ events: LogEvent[] }>

## Plan Revision Notes

Initial creation of the ExecPlan for logs parity.
