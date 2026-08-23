# Production Readiness Audit

Date: 2026-07-27

Verdict: The backend remediation is ready for pull-request review, not deployment. Lifecycle/refund/cancellation races, single-parcel fulfillment safety, endpoint pinning, mapping ambiguity, claim retention, operational health, capacity evidence, and CI isolation are implemented locally with fail-closed controls. The Wix site still lacks required secrets, collections, fields, indexes, permissions, and the audited deployment. Direct staging connectivity currently times out from this runner, no current-SHA staging order-to-delivery evidence exists, alert delivery and capacity have not been measured, and partner cancellation/single-parcel contracts remain unresolved. Do not deploy to Wix, enable production submission, or run a canary until every gate in `WIX_OWNER_HANDOFF.md` passes.

## Stabilized Source Baseline And Current Pull Request

1. Wix HTTP request handling is correct and truthful.
   - Request streams are consumed once, preferring `request.body.buffer()` for byte-exact signatures with a text fallback for older callers.
   - Webhook HMAC uses the exact raw bytes and JSON parsing happens only after authentication.
   - Invalid signatures return 401, malformed events return 400, missing mappings return retryable 503, and failed Wix writes return retryable 500 without marking the event processed.
   - The protected poll trigger returns a failing HTTP status when any selected tracking, status, idempotency, order-read, or fulfillment action fails.
   - Missing endpoint secrets produce controlled 503 responses without exposing secret names.
   - The staging diagnostic is protected by `X-ISEND-POLLER-SECRET`, is enabled only when the site's authoritative environment is staging, ignores environment/force query overrides, and redacts the upstream root and session values.
   - Tracking updates with more than one unique tracking number fail closed before any Wix order read or fulfillment write. The webhook returns 409 `unsupported-multi-tracking`; the poller reports a per-mapping failure.

2. New orders are durable before iSend receives a request.
   - Both legacy `wixStores_onNewOrder` and modern `wixEcom_onOrderApproved` enqueue a normalized snapshot and perform no upstream side effect.
   - Deterministic Wix item IDs make duplicate outbox, mapping, fulfillment-idempotency, webhook-audit, delivery-side-effect, and environment/SKU inventory writes fail closed without relying only on manually configured indexes.
   - The worker uses strongly consistent post-claim state revalidation, deterministic generation-specific claim IDs, and lease fencing to prevent stale concurrent workers from resubmitting an order.
   - Explicit iSend phases distinguish retryable pre-submit failures from ambiguous submit outcomes.
   - An order becomes `sent` only after a business-success response contains queryable `custOrderNo` and the Wix-to-iSend mapping is durable; internal `orderNo`/`orderId` values are not assumed interchangeable.
   - Explicit rejection requires both `success: false` and `actualAdd: false`; every other inconclusive submit response is quarantined instead of retried.
   - Ambiguous outcomes stop in `unknown_outcome` and cannot be automatically requeued without a proven authoritative/idempotent upstream recovery contract.
   - Scheduled-job failures and terminal records are surfaced rather than returned as a successful run.
   - Malformed outbound orders fail before iSend login: identity, items, SKUs, positive quantities/totals, non-negative prices, and required delivery contact/address fields are validated explicitly.
   - Every outbox row and mapping is bound to `staging` or `production`; missing or selector-mismatched durable records stop and alert without calling iSend.

3. Staging monitoring no longer reports skipped work as live success.
   - Pull requests and pushes run locked install, lint, unit tests, and secret-free smoke configuration checks.
   - Scheduled/manual live checks require both direct iSend and protected Wix probes with authenticated-session evidence.
   - Live probes are default-branch only, run inside 10:00-22:00 MYT, use read-only repository permissions, serialize live overlap separately from offline validation, and have timeouts.
   - Manual requests outside the window or from another branch fail explicitly; delayed scheduled checks outside the window report a neutral skip.
   - The status safety net trusts a query only when authoritative `returnObject.totalRecord=1`, exactly one page row is present, and that row's exact `custOrderNo` matches the selected mapping; missing/non-unit totals and empty, extra, or mismatched rows cannot update or fulfill a Wix order.
   - Append-only mapping-mutation leases serialize webhook, delivery, and poller updates so full-item Wix Data writes cannot replace one another.
   - Monotonic transition guards preserve terminal status against delayed webhook/poller events, and stale delivered work cannot create a fulfillment or delivery email after `CANCELLED`/`RETURNED`.

## Current Validation Evidence

- A clean `npm ci` followed by the current `npm run check` passes ESLint and all 381 tests across 20 files on Node 24.18.0. The focused request-body, webhook, endpoint, and CLI-hardening run passes 109/109; the full suite also covers lifecycle/refund/split-shipment, retention/health/capacity, and workflow policy.
- All three CLI scripts pass `node --check`; `jobs.config`, package JSON, and the capacity template parse; `npm audit --omit=dev` reports zero production dependency vulnerabilities; and exact diff checks pass. A high-confidence secret scan found no live secret material; the only credential-bearing URLs are deliberate negative test fixtures. The repository now intentionally has no GitHub Actions workflow YAML.
- The review branch is based exactly on current `origin/main` revision `3880d9028276013914ca116f315585b8f26811af`; the target branch has not diverged since the final fetch.
- Strict offline direct configuration validation passed without printing secret values. A live direct staging login/inventory probe during the MYT service window timed out after ten seconds; redacted TCP checks could not reach the configured host on ports 443, 80, 8080, or 8443.
- The currently published Wix diagnostic route returned 500 without the poller trigger secret and the webhook routes returned 404. Those results describe the old hosted backend, not this local remediation.
- Wix inspection found seven of thirteen required backend secret names. The missing names are `ISTORE_ISEND_DEPLOYED_REVISION`, `ISTORE_ISEND_WEBHOOK_SECRET`, `ISTORE_ISEND_SINGLE_PARCEL_CONTRACT_CONFIRMED`, `ISEND_POLLER_TRIGGER_SECRET`, `ISEND_FULFILLMENT_TRIGGER_SECRET`, and `ISEND_RECOVERY_TRIGGER_SECRET`.
- Wix inspection found only two of nine required integration collections: `ISendOrderOutbox` and `ISendOrderOutboxClaims`. Both are empty, expose content to Everyone, and have no custom indexes. Required fields, permissions, migrations, and indexes are not verified.
- Read-only source inspection confirms the five local live-probe input names required by the staging smoke script. Their values remain unproven until the strict live probe passes. Current hosted alert recipients are not verified. No secret value was read into source, logs, screenshots, or this report.
- Historical GitHub Action runs and prior published Wix probes are useful provenance only. They do not validate this pull-request diff or establish current-SHA staging evidence.

## Required Before Backend Staging Acceptance

Use `WIX_OWNER_HANDOFF.md` as the evidence-based owner-machine execution checklist for these gates.

1. Review and merge only the backend pull request after its final checks pass. Record the exact resulting source SHA; do not infer Wix deployment from a repository merge.
2. Verify all thirteen Wix backend secret names in `STAGING_SETUP.md` and the five repository Actions secret names without exporting their values. Provision the six currently missing Wix names, and bind `ISTORE_ISEND_DEPLOYED_REVISION` to the exact reviewed source SHA. Keep `ISTORE_ISEND_SINGLE_PARCEL_CONTRACT_CONFIRMED` unset or non-`true` until the named iSend approver confirms the complete single-parcel contract.
3. Create or repair all nine Admin-only integration collections, every required field type, and every required index in `STAGING_SETUP.md`. Complete its claim, fulfillment-key, and environment migrations from backups; quarantine every ambiguous row. Retain target-site query-plan evidence where the Wix plan constrains custom indexes.
4. Obtain owner-authorized network access and iSend partner confirmation for the staging origin. Prove DNS/TCP/TLS/login/inventory reachability from both the test runner and the Wix backend without recording credentials or sessions.
5. In a separate, explicitly authorized change window, publish only the exact reviewed backend SHA to Wix staging. Verify the seven lifecycle handlers, protected routes, and all four schedules. No frontend content or editor action is part of this gate.
6. Run the strict local or Wix-side staging probe and retain a fresh direct-plus-Wix authenticated-session pass tied to the same SHA and environment.
7. Execute controlled staging order-to-delivery cases for normal delivery, duplicate events, pre-submit and stable post-submit cancellation, pre/post-submit full refund, partial-refund attention, cancellation/update races during submission and mapping persistence, an authoritative already-partially-fulfilled order, contradictory parcel data, second tracking number, split/partial shipment, webhook/poller races, missing-email retry, and fulfillment replay/recovery. No unsupported case may create an iSend order or Wix fulfillment.
8. Confirm with real partner responses that `custOrderNo` is the authoritative query/webhook identity. Obtain a reviewed post-submit cancellation/void/update contract; until then, post-submit lifecycle changes remain durable operator attention and must not be represented as canceled upstream.
9. Prove alert delivery and accountable escalation for job failure, lifecycle attention, submit/fulfillment ambiguity, retry exhaustion, queue age/backlog, signature spikes, poller failure, retention failure, capacity failure, and stale/missing sensitive-data-policy evidence.
10. Capture measured provider request budgets, aggregate peak Wix Data read/write rates, nonzero P95 and maximum runtimes, queue/backlog behavior, claim-generation growth, lifecycle-intent growth, storage limits, and runway. Run `npm run check:capacity` against attested evidence bound to the exact clean SHA, then apply its `maintenanceStateConfiguration` values to the deterministic `ISendMaintenanceState` row and retain proof that health accepts the same revision.
11. Record owner-approved retention/scrubbing periods, enforcement, approver, policy revision, and recent evidence for raw webhook payloads, sent emails, resolved terminal outbox snapshots, and completed fulfillment-claim results in `ISendMaintenanceState`. Prove operational health stays red when any attestation is absent, stale, or unenforced.
12. Treat production authorization as a later decision. Stop staging intake, resolve every attention/ambiguous state, deactivate staging reconciliation, prove zero environment-binding conflicts, and obtain explicit canary approval before any production selection or traffic.

## Known Follow-Up Risks

- Current elevated Wix eCommerce order reads and fulfillment writes are implemented, but the migrated tracking and delivered-email paths still need one published staging order to prove site permissions and real response shapes.
- Webhook side effects and the final processed marker are not transactional. Canonical fulfillment keys prevent the highest-impact duplicate, but audit/inventory/status writes should eventually move to a durable inbox or delivery-ID state machine.
- Before publishing, complete both `ISendProcessedEvents` migrations in `STAGING_SETUP.md`: convert only one proven completed legacy per-tracking claim per order to the new single-parcel key, and scope only proven raw-webhook claims as `<environment>:<old-key>`. Quarantine ambiguous rows; non-webhook recovery keys must not be prefixed.
- Append-only lifecycle intents have no deletion path. Their measured growth, collection limit, storage runway, and any future owner-approved retention design remain release evidence; do not delete lifecycle evidence merely to make health green.
- Split and partial shipment remain intentionally unsupported. Multiple tracking numbers, partial quantities, contradictory parcel metadata, and already-fulfilled authoritative orders fail closed until the partner and Wix allocation contract is implemented and separately reviewed.
- Inventory polling remains disabled until the partner contract is confirmed, and delivery email still depends on a Wix Automation consuming `ISendPendingEmails`.
- Full `npm audit` reports development-only advisories inherited through the current `@wix/cli` dependency; the production dependency audit is clean. Recheck when Wix publishes an updated dependency chain.
