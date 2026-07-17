# Production Readiness Audit

Date: 2026-07-17

Verdict: The previously merged hardening is on `main`, while the additional outbound-validation and scheduled-reconciliation safeguards described below are pending review on the current pull-request branch. Direct plus published-Wix staging authentication is proven only for the previously published site. Do not enable production order submission until this pull request is merged, the Wix collections/secrets are created, the merged code is published, one end-to-end staging order is reconciled, and the iSend multi-parcel line-item allocation contract is confirmed.

## Stabilized Source Baseline And Current Pull Request

1. Wix HTTP request handling is correct and truthful.
   - Request streams are consumed once, preferring `request.body.buffer()` for byte-exact signatures with a text fallback for older callers.
   - Webhook HMAC uses the exact raw bytes and JSON parsing happens only after authentication.
   - Invalid signatures return 401, malformed events return 400, missing mappings return retryable 503, and failed Wix writes return retryable 500 without marking the event processed.
   - The protected poll trigger returns a failing HTTP status when any selected tracking, status, idempotency, order-read, or fulfillment action fails.
   - Missing endpoint secrets produce controlled 503 responses without exposing secret names.
   - The staging diagnostic is protected by `X-ISEND-POLLER-SECRET`, forced to staging, and redacts the upstream root and session values.
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
   - Live probes are default-branch only, run inside 10:00-22:00 MYT, use read-only repository permissions, cancel overlap, and have timeouts.
   - Manual requests outside the window or from another branch fail explicitly; delayed scheduled checks outside the window report a neutral skip.
   - The status safety net trusts a query only when authoritative `returnObject.totalRecord=1`, exactly one page row is present, and that row's exact `custOrderNo` matches the selected mapping; missing/non-unit totals and empty, extra, or mismatched rows cannot update or fulfill a Wix order.
   - Append-only mapping-mutation leases serialize webhook, delivery, and poller updates so full-item Wix Data writes cannot replace one another.
   - Monotonic transition guards preserve terminal status against delayed webhook/poller events, and stale delivered work cannot create a fulfillment or delivery email after `CANCELLED`/`RETURNED`.

## Current Validation Evidence

- `npm run check`: the unit test suite and ESLint pass on Node 22.22.3.
- `npm ci`, script syntax, workflow YAML parsing, `jobs.config` parsing, and `git diff --check` pass locally.
- `npm audit --omit=dev`: zero production dependency vulnerabilities.
- GitHub repository iSend URL/user/password secrets were reconciled with the locally verified staging configuration without printing their values.
- GitHub Actions run [29557031940](https://github.com/TheRealDesFly/DesFly-Swag-Shop/actions/runs/29557031940) returned authenticated-session evidence from both direct iSend (HTTP 200) and the published Wix staging endpoint (HTTP 200).
- Post-merge GitHub Actions run [29562409367](https://github.com/TheRealDesFly/DesFly-Swag-Shop/actions/runs/29562409367) passed the hardened offline checks on `main`; push-triggered runs intentionally do not perform live probes.
- The earlier dual-probe run exercised the previously published Wix site. The merged protected endpoint still requires Wix publication and a fresh default-branch live run.

## Required Before Go-Live

Use `WIX_OWNER_HANDOFF.md` as the evidence-based owner-machine execution checklist for these gates.

1. Authenticate the Wix CLI or use the Wix dashboard, then set/verify every backend-only secret in `STAGING_SETUP.md`. Current CLI access is unauthenticated. Live probes showed the first three endpoint secrets are not configured, and this branch adds the fourth operator-only recovery secret:
   - `ISTORE_ISEND_WEBHOOK_SECRET`
   - `ISEND_POLLER_TRIGGER_SECRET`
   - `ISEND_FULFILLMENT_TRIGGER_SECRET`
   - `ISEND_RECOVERY_TRIGGER_SECRET`
2. Create all seven Admin-only integration collections and every required field type/index in `STAGING_SETUP.md`. Before publishing, complete its mandatory claim and environment migrations: independently reconcile both mapping identity dimensions, convert only a single proven completed per-tracking fulfillment claim to the order-level key, environment-scope proven raw-webhook claims, and prove/backfill environments on legacy outbox, mapping, webhook-audit, inventory, and pending-email rows. Quarantine every ambiguity.
3. Publish the site so the modern event handler, protected endpoints, hourly `runISendOrderOutboxJob`, and staggered hourly `runISendPollerJob` schedules become active.
4. Run the hardened workflow on the default branch and retain a fresh strict dual-probe pass.
5. Place one staging Wix order and verify: environment-bound event enqueue, one iSend submit, `custOrderNo` extraction, environment-bound mapping, signed tracking webhook, scheduled poller identity check, Wix fulfillment, delivered transition, and email queue record.
6. Confirm with a real create-order response that `custOrderNo` is present and is the correct key for `/Json/WhseOrder/doQueryOrderPage`, and confirm tracking/status webhooks include that same customer-order identity. The worker quarantines responses containing only internal `orderNo`/`orderId` rather than saving a mapping the poller cannot query.
7. Obtain and test the iSend multi-parcel contract that allocates each tracking number to explicit Wix line-item IDs and quantities. Until that contract exists, any order update with multiple unique tracking numbers is intentionally rejected and must not be fulfilled manually without reconciliation.
8. Exercise the fulfillment reconciliation runbook in `STAGING_SETUP.md`: prove completed claims replay safely, and prove `processing`/`unknown_outcome` claims alert and stop until the Wix outcome is confirmed.
9. Load-test capacity. The bounded outbox drains at most five orders per hour, or 60 during the 12-hour service window; the reconciliation poller separately queries at most five active mappings per hour and currently logs in per mapping.
10. Configure alerts for scheduled-job failure, outbox or fulfillment `unknown_outcome`, stale fulfillment `processing`, retry exhaustion, queue age/backlog, invalid-signature spikes, fulfillment failure, and poller failure.
11. Before production selection, stop staging intake and webhook delivery, resolve every staging outbox attention state, require no staging row in a submit-capable state, and require every staging mapping to have `reconciliationActive=false`. After switching, both jobs must report zero environment-binding conflicts before the canary.

## Known Follow-Up Risks

- Current elevated Wix eCommerce order reads and fulfillment writes are implemented, but the migrated tracking and delivered-email paths still need one published staging order to prove site permissions and real response shapes.
- Webhook side effects and the final processed marker are not transactional. Canonical fulfillment keys prevent the highest-impact duplicate, but audit/inventory/status writes should eventually move to a durable inbox or delivery-ID state machine.
- Before publishing, complete both `ISendProcessedEvents` migrations in `STAGING_SETUP.md`: convert only one proven completed legacy per-tracking claim per order to the new single-parcel key, and scope only proven raw-webhook claims as `<environment>:<old-key>`. Quarantine ambiguous rows; non-webhook recovery keys must not be prefixed.
- Inventory polling remains disabled until the partner contract is confirmed, and delivery email still depends on a Wix Automation consuming `ISendPendingEmails`.
- Full `npm audit` reports development-only advisories inherited through the current `@wix/cli` dependency; the production dependency audit is clean. Recheck when Wix publishes an updated dependency chain.
