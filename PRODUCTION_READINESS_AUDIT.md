# Production Readiness Audit

Date: 2026-06-28

Verdict: Remediation in progress. The source-level blockers found in the first audit are addressed in this branch, but full production readiness still requires live Wix staging secrets, published-site smoke checks, and Wix Data index verification.

## Scope

- Wix/Velo backend integration code under `src/backend/`
- iSend order submission, webhook, poller, fulfillment, mapping, and delivery flows
- Local and GitHub Actions staging connectivity checks

## Remediated In This Branch

1. Production and staging iSend URLs are explicitly selected.
   - `ISTORE_ISEND_ENV` selects `staging` or `production`.
   - Production uses only `ISTORE_ISEND_PRODUCTION_URL`.
   - Staging uses `ISTORE_ISEND_SANDBOX_URL`.
   - `getBaseUrl()` now uses the selected `baseUrl`.

2. Manual fulfillment creation is protected.
   - `POST /_functions/createFulfillmentFromWix` now requires `X-ISEND-FULFILLMENT-SECRET`.
   - The header must match Wix secret `ISEND_FULFILLMENT_TRIGGER_SECRET`.

3. Duplicate new-order handling is removed.
   - The extra `wix-backend-events.js` handler was removed.
   - `events.js` now checks for an existing Wix-to-iSend mapping before sending an order to iSend.

4. Fulfillment idempotency is stronger.
   - Fulfillment creation now claims an idempotency key before calling Wix.
   - Completed claims are updated after success.
   - Failed fulfillment attempts release the claim so later retries can run.
   - Webhook fallback idempotency keys are based on a payload hash rather than `Date.now()`.

5. Anonymous demo backend modules are removed.
   - The unused `multiply` demo modules were deleted.
   - Default web-method permissions are now owner-only.

6. Poller behavior is more honest.
   - Tracking and status are the default poller types.
   - Inventory polling reports `inventory-sync-not-configured` instead of logging a placeholder per order.
   - Mapping reads are paged instead of limited to the first 100 records.

7. Staging smoke tooling exists.
   - `npm run check:staging` can test direct iSend staging login and the Wix endpoint.
   - `.github/workflows/isend-staging-smoke.yml` runs lint and staging connectivity checks when secrets are configured.
   - `STAGING_SETUP.md` documents required Wix Backend Secrets and local env vars.

## Still Required Before Go-Live

- Set Wix Backend Secret `ISTORE_ISEND_ENV=staging` for staging and `production` for production.
- Set all iSend, webhook, poller, and fulfillment secrets listed in `STAGING_SETUP.md`.
- Verify the published Wix staging site with `npm run check:staging` using real staging credentials.
- Add unique Wix Data indexes:
  - `ISendOrderMap.wixOrderId`
  - `ISendOrderMap.iSendOrderNo`
  - `ISendProcessedEvents.idempotencyKey`
- Confirm collection permissions for `ISendOrderMap`, `ISendProcessedEvents`, `ISendWebhookEvents`, `ISendInventory`, and `ISendPendingEmails`.
- Run an end-to-end staging order test from Wix order creation through iSend mapping, tracking webhook or poller update, Wix fulfillment, and delivered-email queueing.
- Configure operational alerting for failed iSend submission, missing mapping, failed fulfillment, invalid webhook signature spikes, and poller failures.

## Local Validation Status

- Source fixes have been applied locally in this branch.
- The staging smoke script has a no-secret setup path and will fail fast if required staging env vars are missing.
- Live staging connectivity is not proven until real `ISTORE_ISEND_*` and `WIX_SITE_BASE_URL` values are present in the shell or GitHub Actions secrets.
