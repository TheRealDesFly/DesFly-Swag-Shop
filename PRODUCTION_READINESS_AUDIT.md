# Production Readiness Audit

Date: 2026-07-17

Verdict: The highest-risk source defects are stabilized on this branch, and direct plus published-Wix staging authentication is proven. Do not enable production order submission until the Wix collections/secrets are created, this code is published, one end-to-end staging order is reconciled, and the iSend multi-parcel line-item allocation contract is confirmed.

## Stabilized In This Branch

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
   - Deterministic Wix item IDs make duplicate outbox, mapping, and fulfillment-idempotency writes fail closed without relying only on manually configured indexes.
   - The worker uses strongly consistent post-claim state revalidation, deterministic generation-specific claim IDs, and lease fencing to prevent stale concurrent workers from resubmitting an order.
   - Explicit iSend phases distinguish retryable pre-submit failures from ambiguous submit outcomes.
   - An order becomes `sent` only after a business-success response contains queryable `custOrderNo` and the Wix-to-iSend mapping is durable; internal `orderNo`/`orderId` values are not assumed interchangeable.
   - Explicit rejection requires both `success: false` and `actualAdd: false`; every other inconclusive submit response is quarantined instead of retried.
   - Ambiguous outcomes stop in `unknown_outcome` and cannot be automatically requeued without a proven authoritative/idempotent upstream recovery contract.
   - Scheduled-job failures and terminal records are surfaced rather than returned as a successful run.

3. Staging monitoring no longer reports skipped work as live success.
   - Pull requests and pushes run locked install, lint, unit tests, and secret-free smoke configuration checks.
   - Scheduled/manual live checks require both direct iSend and protected Wix probes with authenticated-session evidence.
   - Live probes are default-branch only, run inside 10:00-22:00 MYT, use read-only repository permissions, cancel overlap, and have timeouts.
   - Manual requests outside the window or from another branch fail explicitly; delayed scheduled checks outside the window report a neutral skip.

## Current Validation Evidence

- `npm run check`: the unit test suite and ESLint pass on Node 22.22.3.
- `npm ci`, script syntax, workflow YAML parsing, `jobs.config` parsing, and `git diff --check` pass locally.
- `npm audit --omit=dev`: zero production dependency vulnerabilities.
- GitHub repository iSend URL/user/password secrets were reconciled with the locally verified staging configuration without printing their values.
- GitHub Actions run [29557031940](https://github.com/TheRealDesFly/DesFly-Swag-Shop/actions/runs/29557031940) returned authenticated-session evidence from both direct iSend (HTTP 200) and the published Wix staging endpoint (HTTP 200).
- That live run exercised the pre-branch workflow and currently published site. The hardened workflow and protected endpoint still require merge, Wix publish, and a fresh live run.

## Required Before Go-Live

1. Authenticate the Wix CLI or use the Wix dashboard, then set/verify every backend-only secret in `STAGING_SETUP.md`. Current CLI access is unauthenticated. Live probes showed the first three endpoint secrets are not configured, and this branch adds the fourth operator-only recovery secret:
   - `ISTORE_ISEND_WEBHOOK_SECRET`
   - `ISEND_POLLER_TRIGGER_SECRET`
   - `ISEND_FULFILLMENT_TRIGGER_SECRET`
   - `ISEND_RECOVERY_TRIGGER_SECRET`
2. Create the Admin-only `ISendOrderOutbox` and `ISendOrderOutboxClaims` collections and the recommended indexes in `STAGING_SETUP.md`. Confirm permissions/indexes on all other integration collections.
3. Publish the site so the modern event handler, protected endpoints, and hourly `runISendOrderOutboxJob` schedule become active.
4. Run the hardened workflow on the default branch and retain a fresh strict dual-probe pass.
5. Place one staging Wix order and verify: event enqueue, one iSend submit, `custOrderNo` extraction, mapping, tracking webhook/poller update, Wix fulfillment, delivered transition, and email queue record.
6. Confirm with a real create-order response that `custOrderNo` is present and is the correct key for `/Json/WhseOrder/doQueryOrderPage`, and confirm tracking/status webhooks include that same customer-order identity. The worker quarantines responses containing only internal `orderNo`/`orderId` rather than saving a mapping the poller cannot query.
7. Obtain and test the iSend multi-parcel contract that allocates each tracking number to explicit Wix line-item IDs and quantities. Until that contract exists, any order update with multiple unique tracking numbers is intentionally rejected and must not be fulfilled manually without reconciliation.
8. Exercise the fulfillment reconciliation runbook in `STAGING_SETUP.md`: prove completed claims replay safely, and prove `processing`/`unknown_outcome` claims alert and stop until the Wix outcome is confirmed.
9. Load-test capacity. The bounded hourly batch drains at most five orders per hour, or 60 during the 12-hour service window.
10. Configure alerts for scheduled-job failure, outbox or fulfillment `unknown_outcome`, stale fulfillment `processing`, retry exhaustion, queue age/backlog, invalid-signature spikes, fulfillment failure, and poller failure.

## Known Follow-Up Risks

- Current elevated Wix eCommerce order reads and fulfillment writes are implemented, but the migrated tracking and delivered-email paths still need one published staging order to prove site permissions and real response shapes.
- Webhook side effects and the final processed marker are not transactional. Canonical fulfillment keys prevent the highest-impact duplicate, but audit/inventory/status writes should eventually move to a durable inbox or delivery-ID state machine.
- Inventory polling remains disabled until the partner contract is confirmed, and delivery email still depends on a Wix Automation consuming `ISendPendingEmails`.
- Full `npm audit` reports development-only advisories inherited through the current `@wix/cli` dependency; the production dependency audit is clean. Recheck when Wix publishes an updated dependency chain.
