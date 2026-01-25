# Gateway Control Panel Parity With Clawdbot (Local First)

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan must be maintained in accordance with `.agent/PLANS.md`.

## Purpose / Big Picture

After this change, a local operator can run the Omni gateway and Admin UI in a way that matches Clawdbot’s control-panel flow: the UI connects directly to the gateway over a WebSocket, authenticates with a user-provided token, receives a status snapshot, can trigger a manual daily report, and can view and edit core gateway settings (Telegram allowlists and cron/reporting settings) from the UI. The proof of success is that the UI shows live status via the WebSocket connection, the “Run report” button triggers a successful gateway method call (or returns a clear error if Jira is not configured), and updating Telegram/cron settings in the UI immediately affects the gateway behavior without editing local files.

## Progress

- [x] (2026-01-25T00:00Z) Define the WebSocket gateway protocol surface (hello/connect, status snapshot, cron run, config get/set).
- [x] (2026-01-25T00:00Z) Add a gateway config store (Durable Object) and overlay config on Worker env.
- [x] (2026-01-25T00:00Z) Implement WebSocket endpoint in the Worker with token auth and method dispatch.
- [x] (2026-01-25T00:00Z) Add a browser gateway client in the Admin UI and wire status + cron + config forms.
- [ ] (2026-01-25T00:00Z) Validate local flows: status snapshot, manual cron, and config updates applied in gateway behavior.

## Surprises & Discoveries

- Observation: None yet.
  Evidence: N/A.

## Decision Log

- Decision: Use a WebSocket gateway endpoint in `worker/index.ts` while keeping existing HTTP admin endpoints for backward compatibility.
  Rationale: This provides Clawdbot-like local parity without breaking the current admin UI or scripts.
  Date/Author: 2026-01-25 / Codex
- Decision: Authenticate WebSocket connections with the same `ADMIN_API_TOKEN` used for HTTP admin routes.
  Rationale: Minimizes new secrets and keeps local setup consistent with existing config.
  Date/Author: 2026-01-25 / Codex
- Decision: Persist the gateway URL and token in the Admin UI via `localStorage`.
  Rationale: Mirrors Clawdbot’s local UX where the operator inputs a token in the UI.
  Date/Author: 2026-01-25 / Codex
- Decision: Implement a gateway config store via a Durable Object and overlay it on Worker env for runtime behavior.
  Rationale: Enables UI-driven settings changes without writing `.env` files or requiring Worker restarts.
  Date/Author: 2026-01-25 / Codex
- Decision: Restructure the Admin UI into a sidebar layout with dedicated Overview and Settings routes.
  Rationale: Matches the Midday-style admin panel structure requested by the user and keeps settings separate from status dashboards.
  Date/Author: 2026-01-25 / Codex

## Outcomes & Retrospective

- Pending. This section will be updated after milestones complete.

## Context and Orientation

Omni currently exposes HTTP admin endpoints from the Cloudflare Worker in `worker/index.ts` (e.g., `GET /admin/status`, `POST /admin/cron/run`). The Admin UI in `apps/admin` fetches those endpoints and allows manual cron runs. Clawdbot’s control UI, by contrast, connects to a gateway using a WebSocket protocol and sends an authenticated “connect” request that returns a “hello” response and a status snapshot, then uses WebSocket RPC methods to query and update gateway settings. To achieve parity, we will introduce a WebSocket endpoint in the Worker and update the Admin UI to use a browser gateway client over WebSocket for status, cron, and a small but meaningful set of settings (Telegram allowlists and cron/reporting options).

Important files:

- `worker/index.ts`: Cloudflare Worker entry; will host the WebSocket endpoint and method dispatch.
- `apps/admin/app/page.tsx`: Admin UI page; will be updated to use a WebSocket client for status and cron.
- `apps/admin/components/cron-runner.tsx`: Manual run UI; may need to call gateway methods instead of HTTP.
- `apps/admin/lib/`: New utilities for a browser gateway client, protocol types, and config shape.
- `apps/bot/src/lib/reports/daily-status.ts`: Daily report generator; the gateway calls into this for cron runs.

Definitions:

- “Gateway WebSocket endpoint”: A WebSocket route (for example, `/gateway`) handled by the Worker that accepts JSON messages, authenticates the user with a token, and responds with JSON frames (requests/responses/events).
- “Hello/Connect”: The initial request from the UI to authenticate and receive a status snapshot. This matches Clawdbot’s flow but will be simplified to Omni’s needs.
- “Gateway config store”: A Durable Object that stores a JSON object of runtime settings. The Worker reads these settings on each request and overlays them on top of environment variables.

## Plan of Work

First, define a minimal WebSocket protocol for local parity plus core settings. The browser client will send a JSON frame like `{ "type": "req", "id": "...", "method": "connect", "params": { "token": "..." } }`. The Worker will reply with `{ "type": "res", "id": "...", "ok": true, "payload": { "status": { ... }, "config": { ... } } }`. The `status` payload should reuse the same shape currently returned by `GET /admin/status`. The `config` payload should include a subset of settings needed for the UI (Telegram allowlists, cron settings, gateway plugin lists, and admin allowlist). This ensures the UI can render and edit settings without new mapping.

Next, implement a gateway config store in a new Durable Object (for example, `GatewayConfigDO`) stored in `worker/index.ts` or a new `worker/gateway-config.ts`. The DO should:

- Store a JSON object with the settings subset needed by the UI.
- Provide `getConfig()` and `setConfig(partial)` helpers.
- Persist settings in DO storage so they survive restarts.

Then, implement the WebSocket route in `worker/index.ts`. If the request is a WebSocket upgrade on the chosen path, the Worker should accept the socket, read JSON frames, validate the token for the `connect` method, and support at least four methods:

1. `connect`: Validate token, return `status` snapshot.
2. `config.get`: Return the current gateway config (from DO).
3. `config.set`: Update the gateway config (write to DO) and return the updated config.
4. `cron.run`: Trigger the existing daily report path (`buildDailyStatusReportParts`) and return a JSON result `{ ok: true, blocks: number }` or `{ ok: false, error: string }`.

Keep the existing HTTP admin endpoints unchanged. This allows older tooling to continue working and provides a fallback for testing. The HTTP handlers should also read the config overlay so that status and cron run match the WebSocket behavior.

Then, add a browser gateway client in `apps/admin/lib/gateway-client.ts` (new file) that manages a WebSocket connection and exposes `connect()`, `getConfig()`, `setConfig()`, and `runCron()` methods returning promises. The client should accept a base URL and token, open a WebSocket connection, send a `connect` request, and provide a `request(method, params)` helper. Implement simple reconnect behavior or explicit “Connect” button; avoid complex reconnection until the minimal flow works.

Update `apps/admin/app/page.tsx` and `apps/admin/components/cron-runner.tsx` to use this client. When the user clicks “Save & refresh”, create or refresh the gateway client, run `connect`, and store the returned `status` and `config`. Add a settings panel for Telegram allowlists and cron/reporting settings that edits the config and calls `config.set`. The “Run report” button should call `cron.run` on the gateway client and show success or error in the status badge.

Finally, add minimal validation guidance and troubleshooting notes in `docs/admin-ui.md` describing that the UI uses WebSocket gateway for local parity, the token is entered in the UI, and how to run the Worker locally.

## Concrete Steps

1) Add a gateway config Durable Object and binding.
   - Update `worker/wrangler.toml` to bind a new DO (e.g., `GATEWAY_CONFIG_DO`).
   - Add a `GatewayConfigDO` class and helper functions to get and set config.
   - Define the config JSON shape (Telegram allowlists, cron settings, gateway plugins, admin allowlist).

2) Add WebSocket handling in `worker/index.ts`.
   - Detect `Upgrade: websocket` on path `/gateway`.
   - Accept the WebSocket and dispatch JSON frames.
   - Implement `connect`, `config.get`, `config.set`, and `cron.run` methods as described above.
   - Keep existing HTTP admin routes and ensure they use the config overlay.

3) Create `apps/admin/lib/gateway-client.ts`.
   - Define frame types: request, response, and minimal error.
   - Implement `request(method, params)` with a request-id map.
   - Provide `connect()`, `getConfig()`, `setConfig()`, and `runCron()` helpers.

4) Update `apps/admin/app/page.tsx`.
   - Replace direct HTTP status fetch with gateway client connection.
   - On “Save & refresh”, call `connect` and set `status` plus `config`.
   - Add settings form for Telegram allowlists and cron/reporting config.
   - Keep `localStorage` settings behavior.

5) Update `apps/admin/components/cron-runner.tsx`.
   - Accept a gateway client instance or a `runCron` callback.
   - Show success/failure in the badge.

6) Update `docs/admin-ui.md`.
   - Document the WebSocket flow and local `wrangler dev` usage.

## Validation and Acceptance

Start the system locally and verify:

- Worker: run from repo root with
    cd /Users/murad-pc/Documents/Github/omni
    bunx wrangler dev --config worker/wrangler.toml
  Expected output includes `Ready on http://localhost:8787` and WebSocket upgrades when the UI connects.

- Admin UI: run from `apps/admin` with
    bun dev
  Open `http://localhost:3000`, set gateway URL to `http://localhost:8787`, enter the token, and click “Save & refresh”.
  Acceptance: the UI displays a status snapshot without HTTP `GET /admin/status` calls, and the Worker logs show the WebSocket request/response flow.

- Manual cron: click “Run report”.
  Acceptance: if Jira is configured, the UI shows a success badge and the Worker logs a successful `cron.run` response; if Jira is not configured, the UI shows the error message from the gateway.

- Config update: edit Telegram allowlists or cron settings in the UI and save.
  Acceptance: the UI shows the new values after refresh, and gateway behavior uses the updated config (for example, Telegram allowlist blocks unexpected users or cron status reflects new settings).

## Idempotence and Recovery

All steps are additive. Re-running the commands is safe. If the WebSocket implementation fails, revert to the existing HTTP admin paths by keeping the UI code unchanged (or using a feature flag) and confirm `/admin/status` still works.

## Artifacts and Notes

Expected WebSocket request example (sent from UI):

    {"type":"req","id":"uuid","method":"connect","params":{"token":"..."}}

Expected WebSocket response example:

    {"type":"res","id":"uuid","ok":true,"payload":{"status":{"serviceName":"omni","version":"dev"}}}

## Interfaces and Dependencies

Implement the gateway WebSocket in `worker/index.ts` using the native Cloudflare Worker WebSocket API and a new Durable Object for config. Define the following types in `apps/admin/lib/gateway-client.ts`:

    export type GatewayRequestFrame = {
      type: "req";
      id: string;
      method: string;
      params?: unknown;
    };

    export type GatewayResponseFrame = {
      type: "res";
      id: string;
      ok: boolean;
      payload?: unknown;
      error?: { message: string };
    };

Provide a client class:

    export class GatewayClient {
      constructor(opts: { url: string; token: string });
      connect(): Promise<{ status: AdminStatus; config: GatewayConfig }>;
      getConfig(): Promise<GatewayConfig>;
      setConfig(next: GatewayConfig): Promise<GatewayConfig>;
      runCron(): Promise<{ ok: boolean; blocks?: number; error?: string }>;
      close(): void;
    }

The `connect()` method must return the status snapshot with the same shape as the HTTP `/admin/status` response, plus the gateway config, to keep UI rendering unchanged.

## Plan Revision Notes

2026-01-25: Expanded scope to include a config store and UI settings parity (Telegram allowlists and cron/reporting) to align with Clawdbot’s control-panel behavior. This reflects the user’s request for a full control panel, not just a dashboard.
