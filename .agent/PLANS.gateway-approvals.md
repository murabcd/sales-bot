# Gateway Approvals UI (Local Parity)

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan must be maintained in accordance with `.agent/PLANS.md`.

## Purpose / Big Picture

After this change, the Admin UI will expose a live approvals queue so an operator can approve or deny tool executions without leaving the dashboard. This matches Clawdbot’s approvals control panel. Success is visible when a pending approval appears in the UI, the operator approves/denies it, and the bot continues or stops accordingly.

## Progress

- [ ] (2026-01-25T00:00Z) Map the current approvals storage and lifecycle in the bot runtime.
- [ ] (2026-01-25T00:00Z) Add gateway RPC methods for listing and resolving approvals.
- [ ] (2026-01-25T00:00Z) Add approvals page and UI actions in the Admin UI.
- [ ] (2026-01-25T00:00Z) Validate end-to-end approval flow.

## Surprises & Discoveries

- Observation: None yet.
  Evidence: N/A.

## Decision Log

- Decision: Reuse the existing approvals storage at `apps/bot/src/lib/tools/approvals.ts` and expose it via gateway RPC.
  Rationale: Avoids parallel storage and keeps the approvals source of truth unchanged.
  Date/Author: 2026-01-25 / Codex

## Outcomes & Retrospective

- Pending. This section will be updated after milestones complete.

## Context and Orientation

Approvals are implemented in the bot runtime under `apps/bot/src/lib/tools/approvals.ts` and written to disk via `TOOL_APPROVAL_STORE_PATH`. The Worker gateway already handles admin and cron requests and can be extended to call into bot logic. The Admin UI has a WebSocket client that can call RPC methods. We will expose approvals data through the gateway and build an approvals page.

## Plan of Work

First, inspect `apps/bot/src/lib/tools/approvals.ts` to confirm the data format and how approvals are listed/resolved. Then create gateway RPC methods:

- `approvals.list` → returns the pending approvals array.
- `approvals.resolve` → accepts `{ id, decision, reason? }` and resolves the approval.

The gateway should call into the existing approvals store functions. For local dev, use the same file path and ensure the Worker can access it (if running in local dev mode). If the Worker cannot access the approvals store in production, keep this local-only and document it.

Add a new Admin UI route `apps/admin/app/(app)/approvals/page.tsx`, render a list/table of pending approvals, and provide Approve/Deny buttons that call `approvals.resolve`. Include a small refresh/poll interval so new approvals appear.

## Concrete Steps

1) Read `apps/bot/src/lib/tools/approvals.ts` and identify `listApprovals` and `resolveApproval` (or equivalent).
2) Expose gateway RPC methods in `worker/index.ts` and `apps/admin/lib/gateway-client.ts`.
3) Add an Approvals page in Admin UI and a sidebar link.
4) Update docs to mention approvals in the admin panel.

## Validation and Acceptance

Start the bot and worker. Trigger a tool that requires approval (set `TOOL_APPROVAL_REQUIRED=1`). Confirm:
- A pending approval appears in the Approvals page.
- Clicking Approve or Deny resolves it and removes it from the list.
- The bot continues or cancels the tool action accordingly.

## Idempotence and Recovery

Approvals are additive. If the UI fails, approvals can still be resolved manually by editing the approvals store or disabling approvals in env.

## Artifacts and Notes

Example approvals payload:

    {"id":"appr_123","createdAt":1737780000000,"tool":"web.search","input":{...},"status":"pending"}

## Interfaces and Dependencies

Add gateway methods:

    approvals.list(): { approvals: Approval[] }
    approvals.resolve(params: { id: string; decision: "approve" | "deny"; reason?: string }): { ok: boolean }

Add client helpers in `apps/admin/lib/gateway-client.ts`:

    approvalsList(): Promise<{ approvals: Approval[] }>
    approvalsResolve(params: { id: string; decision: "approve" | "deny"; reason?: string }): Promise<{ ok: boolean }>

## Plan Revision Notes

Initial creation of the ExecPlan for approvals parity.
