# Production Readiness Audit

Date: 2026-06-28

Verdict: Not production-ready yet.

This repo has the core of a Wix/Velo iSend fulfillment integration, but there are several launch blockers around production environment selection, exposed HTTP functionality, duplicate order event handling, idempotency guarantees, and missing verification.

## Scope

- Wix/Velo backend integration code under `src/backend/`
- iSend order submission, webhook, poller, fulfillment, mapping, and delivery flows
- Repo scripts, local validation setup, and documented operational workflows

The available Product Design audit skill is oriented toward screenshot-backed product flow audits. This readiness audit is code and operations focused because the repo does not include a live product URL, requested user flow, or screenshot destination.

## Launch Blockers

1. Production iSend traffic still defaults to sandbox.
   - `getISendConfig()` defaults `useSandbox` to `true`.
   - `getBaseUrl()` always returns `config.sandboxUrl`, even though `getISendConfig()` calculates a selected `baseUrl`.
   - `sendOrderToISend()`, `loginToISend()`, and `getTrackingInfo()` call config/login without passing a production mode.
   - Evidence: `src/backend/isendConfig.js:35`, `src/backend/isendConfig.js:52`, `src/backend/isendService.js:29`, `src/backend/isendService.js:115`, `src/backend/isendService.js:239`, `src/backend/isendService.js:264`.
   - Impact: a production store can continue submitting or polling against sandbox, or silently fall back to sandbox if production URL is missing.

2. Fulfillment creation is exposed through an unauthenticated HTTP endpoint.
   - `post_createFulfillmentFromWix()` accepts `orderId`, tracking data, and an optional idempotency key from the request body, then calls `createFulfillment()` directly.
   - Unlike `post_runISendPoller()`, it does not validate a secret, signature, member role, or caller identity.
   - Evidence: `src/backend/http-functions.js:66`, `src/backend/http-functions.js:67`, `src/backend/http-functions.js:88`, `src/backend/http-functions.js:99`, `src/backend/http-functions.js:108`.
   - Impact: anyone who can reach the endpoint may be able to create fulfillment records for arbitrary orders if they know or can guess an order ID.

3. New-order handling is duplicated and inconsistent.
   - Both `events.js` and `wix-backend-events.js` export `wixStores_onNewOrder`.
   - Only `events.js` saves the Wix-to-iSend mapping required by webhooks and the poller.
   - Evidence: `src/backend/events.js:31`, `src/backend/events.js:50`, `src/backend/wix-backend-events.js:8`, `src/backend/wix-backend-events.js:12`.
   - Impact: order submission may run twice, or the active handler may submit to iSend without saving a mapping, breaking tracking and status updates.

4. Idempotency is check-then-insert, not atomic.
   - `hasProcessed()` queries first, then `markProcessed()` inserts later.
   - There is no unique constraint handling or collision-safe upsert in code.
   - Webhook delivery IDs fall back to a timestamp-derived key when no delivery ID exists.
   - Evidence: `src/backend/isendIdempotency.js:12`, `src/backend/isendIdempotency.js:27`, `src/backend/isendIdempotency.js:34`, `src/backend/isendWebhookHandler.js:109`.
   - Impact: concurrent duplicate webhooks or poller retries can still create duplicate fulfillments or duplicate pending delivery emails.

5. Local verification is not currently runnable in this workspace.
   - `package.json` defines `npm run lint`, but this workspace has no installed dependencies and no lockfile.
   - Running `npm run lint` failed because `eslint` is not available.
   - No test files were found.
   - Evidence: `package.json:3`, `package.json:11`, `.eslintrc.json:2`.
   - Impact: there is no repeatable local quality gate before publishing.

## High-Priority Hardening

1. Replace the production/sandbox selection with an explicit deploy-time mode.
   - Add a required Wix secret such as `ISTORE_ISEND_ENV=production|sandbox`.
   - Return `baseUrl` from `getISendConfig()` and make `getBaseUrl()` use `config.baseUrl`.
   - Fail closed in production when the production URL is absent.

2. Remove or secure `post_createFulfillmentFromWix()`.
   - Best option: remove it if it is only a test helper.
   - If it must remain, require an HMAC signature or backend-only secret header and return `401/403` instead of `500` for unauthorized requests.

3. Keep only one Wix Stores new-order handler.
   - Preserve the version that saves `ISendOrderMap`.
   - Add duplicate-order protection before sending to iSend by checking for an existing mapping or idempotency key based on the Wix order ID.

4. Make idempotency durable.
   - Enforce uniqueness on `idempotencyKey` in `ISendProcessedEvents` if Wix collection settings allow it.
   - Treat duplicate insert errors as successful idempotency skips.
   - Avoid `Date.now()` fallback keys for webhook events that can affect fulfillment.

5. Add a basic CI gate.
   - Commit a lockfile.
   - Add at least lint plus focused tests for mapping, status mapping, idempotency behavior, webhook signature handling, and payload extraction.
   - Add smoke-test documentation or workflows only if the workflow files are actually present.

## Other Risks

- `permissions.json` grants anonymous invoke access by default for all web methods, and several sample `.web.js` modules expose `multiply` with `Permissions.Anyone`. These look like scaffolding, but they should be removed or locked down before launch.
- Inventory sync is documented as part of the poller surface but remains a TODO placeholder.
- The poller only reads the first 100 mappings and does not page through older orders.
- Several error paths log and continue, which is reasonable for resilience but needs alerting so failed mappings, fulfillment creation failures, or webhook processing errors are visible.
- The docs mention GitHub Actions workflow files, but `.github/` is not present in this repo snapshot.

## Suggested Go-Live Checklist

- Production iSend credentials and URL configured in Wix Secrets.
- Sandbox mode cannot be selected accidentally in production.
- Webhook signature verified against the exact raw request body from Wix.
- `post_createFulfillmentFromWix()` removed or authenticated.
- Only one `wixStores_onNewOrder` handler remains.
- Duplicate Wix order submissions are prevented.
- `ISendOrderMap`, `ISendProcessedEvents`, `ISendWebhookEvents`, `ISendInventory`, and `ISendPendingEmails` exist with correct permissions and indexes.
- Webhook, poller, and delivered-email flows tested against staging data.
- Lint and automated tests run cleanly in CI.
- Operational alerting exists for failed iSend submission, missing mapping, failed fulfillment, invalid webhook signature spikes, and poller failures.
