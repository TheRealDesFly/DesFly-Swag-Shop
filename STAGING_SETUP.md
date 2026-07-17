# Wix + iStore iSend Staging Setup

Use this checklist before publishing or running the staging smoke test.

## Wix Backend Secrets

Set these in Wix as backend-only secrets:

- `ISTORE_ISEND_ENV`: `staging`
- `ISTORE_ISEND_STORAGE_CLIENT_NO`
- `ISTORE_ISEND_API_USER_ID`
- `ISTORE_ISEND_API_PASSWORD`
- `ISTORE_ISEND_ORDER_ORIGIN`
- `ISTORE_ISEND_SANDBOX_URL`
- `ISTORE_ISEND_PRODUCTION_URL`
- `ISTORE_ISEND_WEBHOOK_SECRET`
- `ISEND_POLLER_TRIGGER_SECRET`
- `ISEND_FULFILLMENT_TRIGGER_SECRET`
- `ISEND_RECOVERY_TRIGGER_SECRET`

Production must set `ISTORE_ISEND_ENV` to `production`. The backend now uses the production URL only when that environment is selected, and it no longer falls back from production to staging.

## Wix Data Collections

Create these collections with Admin-only read/write permissions before publishing the order worker:

- `ISendOrderOutbox` stores the complete Wix order snapshot and queue state. Add a regular index on `orderKey` plus compound indexes on (`status`, `nextAttemptAt`), (`status`, `retryExhausted`), and (`status`, `leaseExpiresAt`).
- `ISendOrderOutboxClaims` stores append-only, generation-fenced worker leases. Add a compound index on `claimKey`, `generation` and a regular index on `leaseExpiresAt`.
- `ISendOrderMap` maps Wix orders to iSend orders. Add a regular index on `wixOrderId` and use the collection's unique-index slot on `iSendOrderNo`. The deterministic mapping item ID already enforces one mapping per Wix order.
- `ISendProcessedEvents` stores webhook and fulfillment idempotency records. Add a unique index on `idempotencyKey`; deterministic item IDs enforce new-code concurrency while the unique index also protects legacy auto-ID rows during rollout.
- `ISendWebhookEvents`, `ISendInventory`, and `ISendPendingEmails` store audit, inventory, and delivery-email records.

The outbox, mapping, and idempotency modules also use deterministic Wix item IDs, so duplicate writes fail closed even before most custom indexes are available. Before creating the `ISendProcessedEvents.idempotencyKey` unique index, reconcile/remove any existing duplicate-key rows; the runtime strongly checks legacy rows, and the unique index closes the old/new deployment race.

Configure the worker and side-effect claim collections with these field types. Wix supplies its normal system fields in addition to these application fields.

| Collection | Field | Wix field type | Required purpose |
| --- | --- | --- | --- |
| `ISendOrderOutbox` | `orderKey`, `wixOrderId`, `status` | Text | Stable order identity and queue state |
| `ISendOrderOutbox` | `orderSnapshot`, `lastError`, `responseSummary`, `unknownOutcomeDetails` | Object | Durable order payload and bounded diagnostics |
| `ISendOrderOutbox` | `attemptCount`, `maxAttempts`, `claimGeneration` | Number | Retry and lease fencing counters |
| `ISendOrderOutbox` | `retryExhausted` | Boolean | Terminal retry guard |
| `ISendOrderOutbox` | `nextAttemptAt`, `leaseExpiresAt`, `enqueuedAt`, `updatedAt`, `sourceEventTime`, `lastAttemptStartedAt`, `lastAttemptFinishedAt`, `unknownOutcomeAt`, `sentAt`, `requeuedAt` | Date and Time | Scheduling, lease, source, and audit timestamps |
| `ISendOrderOutbox` | `leaseToken`, `iSendOrderNo`, `unknownOutcomeReason`, `requeueReason`, `sourceEventId`, `sourceShape` | Text | Ownership, mapping, recovery, and source metadata |
| `ISendOrderOutboxClaims` | `claimKey`, `orderKey`, `leaseToken` | Text | Lease identity and ownership |
| `ISendOrderOutboxClaims` | `generation` | Number | Numeric descending sort and monotonic fencing; do not configure this as Text |
| `ISendOrderOutboxClaims` | `claimedAt`, `leaseExpiresAt`, `releasedAt` | Date and Time | Lease lifecycle and expiry queries |
| `ISendProcessedEvents` | `idempotencyKey` | Text | Webhook or canonical fulfillment key |
| `ISendProcessedEvents` | `meta` | Object | Fulfillment state and bounded result/failure metadata |
| `ISendProcessedEvents` | `createdAt`, `updatedAt` | Date and Time | Claim lifecycle timestamps |

The compound `ISendOrderOutboxClaims` index must use `claimKey` then numeric `generation`; `nextAttemptAt` and `leaseExpiresAt` must remain Date and Time fields because the worker sorts and compares them. Changing those fields to Text can make generations sort lexically after 9 or make due/expired queries incorrect.

Claim generations are append-only to prevent lease ID reuse. Monitor collection growth and add a retention job after measuring staging volume. A retention job may archive or delete old released generations only after a generous safety interval, and it must always preserve the highest generation for every `claimKey`; deleting the latest row would reset monotonic fencing.

`src/backend/jobs.config` runs the outbox worker hourly. It processes a bounded five-order batch only inside 10:00-22:00 MYT. Validate that this maximum of 60 orders per service-window day fits expected volume before production; increase or redesign the worker only after measuring Wix job runtime and iSend rate limits.

## Multi-Parcel Fulfillment Contract

Multi-parcel fulfillment is a go-live blocker. Obtain an iSend response/webhook contract that allocates each unique tracking number to specific Wix eCommerce line-item IDs and quantities, then verify that allocation with a real staging order. A tracking-number list without line-item allocation is not sufficient because the same Wix line item cannot be fulfilled once for every parcel.

Until that contract is implemented, the integration fails closed when a payload contains more than one unique tracking number. The webhook returns HTTP 409 with code `unsupported-multi-tracking`, and the poller returns `success: false` with a per-mapping `tracking-allocation` failure. Neither path reads the Wix order or creates a fulfillment for that update.

## Local Staging Smoke Test

Set these local environment variables when testing from your machine:

- `ISTORE_ISEND_API_USER_ID`
- `ISTORE_ISEND_API_PASSWORD`
- `ISTORE_ISEND_SANDBOX_URL`
- `ISTORE_ISEND_STORAGE_CLIENT_NO`
- `WIX_SITE_BASE_URL`
- `ISEND_POLLER_TRIGGER_SECRET`

Use the direct iStore/iSend host or API context root for `ISTORE_ISEND_SANDBOX_URL`. The backend appends `/Json/...` paths and automatically tries the `/IsisWMS-War` context root when the configured URL is host-only. Do not use a Wix site URL or any `/_functions/...` route for this value; the smoke script rejects that configuration before making a request.

Verified official context roots:

- Staging: `https://staging.istoreisend-wms.com:5191/IsisWMS-War`
- Production: `https://istoreisend-wms.com:5191/IsisWMS-War`
- Alternate web API host supplied for testing: `https://webapi.istoreisend-wms.com/IsisWMS-War`

You can put these values in an untracked `.env` file. Start from `.env.example`; the smoke script loads `.env` automatically and does not print secret values.

Check whether local configuration is present:

```bash
npm run check:staging:setup
```

To require both the direct iSend and published Wix configurations, as CI does before a live probe:

```bash
npm run check:staging:setup -- --require-direct --require-wix
```

Setup validation is offline. It validates configuration shape and does not contact iSend or Wix.

Run redacted endpoint diagnostics:

```bash
npm run check:staging:diagnose
```

Then run:

```bash
npm run check:staging
```

To also call the inventory endpoint from the iStore/iSend Postman example:

```bash
npm run check:staging -- --inventory
```

By default, the script performs whichever checks it has enough valid configuration for:

- Direct iSend staging login using local iSend credentials. A business-level success without usable session fields or a `JSESSIONID` cookie fails the check. Session presence is reported, but session values are never printed.
- Published Wix endpoint check at `/_functions/testISendLoginFromWix?env=staging`. The script sends `ISEND_POLLER_TRIGGER_SECRET` as `X-ISEND-POLLER-SECRET`; the endpoint always tests staging, redacts the upstream root, and must report authenticated-session evidence.
- Direct inventory query when `--inventory` is provided; it logs in first and sends the returned iSend session cookie/session fields with the inventory request.

It does not print secret values. Live iSend and Wix login probes are skipped outside the configured 10:00 AM-10:00 PM Malaysia Time service window unless you pass `--force`.

The JSON result uses explicit outcomes:

- `outcome: "passed"` means every selected live probe ran and passed.
- `outcome: "neutral"` means no live probe ran, normally because all selected checks were outside the service window. This is not reported as a success.
- `outcome: "partial"` means at least one probe passed and at least one was skipped. This is not reported as a complete success.
- `outcome: "failed"` means at least one attempted probe failed.

Outside-window `neutral` and `partial` results exit successfully for normal local use, while `--require-live` makes either result non-zero. `--require-live` also requires both the direct iSend and Wix configurations/checks unless `--skip-direct` or `--skip-wix` is explicitly supplied. CI uses `--require-live` only after its MYT service-window gate.

To intentionally test outside the service window:

```bash
npm run check:staging -- --force --inventory
```

## Troubleshooting Local Smoke Tests

- iStore/iSend staging may only be active during the partner-provided service window. Current code uses 10:00 AM-10:00 PM Malaysia Time.
- `skipped: true` with `Outside iStore iSend service window`: the command did not call iSend because the current Malaysia Time is outside the configured staging window. Run again during the window or pass `--force` for an intentional live probe.
- `ISTORE_ISEND_SANDBOX_URL must point directly to iSend`: the iSend secret contains a Wix `/_functions` or `/_functions-dev` route. Replace it with the direct staging context root shown above. `WIX_SITE_BASE_URL` is the separate setting for the published Wix site.
- `connect ETIMEDOUT [address]` on `direct-isend-staging`: the configured iSend staging host is not reachable from the local network on its configured port. Check VPN, firewall, allowlist, endpoint host, and whether the iSend staging service is up.
- `Wix staging iSend endpoint failed with status 404`: `WIX_SITE_BASE_URL` is reachable, but the published site at that URL does not expose `/_functions/testISendLoginFromWix`. Check that the URL points to the intended Wix site/environment and that the backend code is published there.
- `Wix staging iSend endpoint failed with status 401` or `503`: the protected diagnostic header does not match the Wix Backend Secret, or `ISEND_POLLER_TRIGGER_SECRET` is not configured in Wix.
- `unable to verify the first certificate`: on Windows, retry with Node's system certificate store, for example `NODE_OPTIONS=--use-system-ca npm run check:staging`.
- The default local smoke-test timeout is 20 seconds. Override it with `CHECK_ISEND_TIMEOUT` or `--timeout` when diagnosing slow networks.

`npm run check:staging:diagnose` reports Wix route status codes and iSend port reachability without printing the configured hostnames or secrets. It does not request the force-enabled Wix diagnostic routes.

## GitHub Actions Secrets

For `.github/workflows/isend-staging-smoke.yml`, configure:

- `ISTORE_ISEND_API_USER_ID`
- `ISTORE_ISEND_API_PASSWORD`
- `ISTORE_ISEND_SANDBOX_URL`
- `WIX_SITE_BASE_URL`
- `ISEND_POLLER_TRIGGER_SECRET`

The workflow has three deliberately separate behaviors:

- Every pull request and push runs PR-safe offline checks: `npm ci`, lint, the unit test suite, script syntax, acceptance of a plausible direct iSend root, and rejection of a Wix function URL. Forked pull requests do not receive secrets and make no staging requests.
- Scheduled runs occur at 11:23, 15:23, and 19:23 MYT. This replaces the previous every-30-minute schedule to reduce load while retaining three daily checks.
- Scheduled and manually dispatched runs pass through a 10:00-22:00 MYT gate and are restricted to the repository's default branch. An outside-window manual request or non-default-branch live request fails explicitly; a delayed scheduled run outside the window records a neutral skip. Inside the window, CI requires all five secrets above, then requires both the direct iSend and published Wix probes to run and pass. Missing secrets, skipped probes, and failed probes cannot satisfy the live job.

The workflow has read-only repository permissions, cancels overlapping runs for the same ref, and bounds every job with a timeout.

## Retry-Exhausted Requeue And Unknown Outcomes

The protected recovery endpoint uses the separate operator-only `ISEND_RECOVERY_TRIGGER_SECRET` and applies only to retry-exhausted records whose failures were conclusively before submission. Do not give this credential to the automated poller or smoke monitor. After correcting the configuration/login cause, re-enable one with:

```bash
curl -X POST "$WIX_SITE_BASE_URL/_functions/requeueISendOrder" \
  -H "Content-Type: application/json" \
  -H "X-ISEND-RECOVERY-SECRET: $ISEND_RECOVERY_TRIGGER_SECRET" \
  -d '{"orderKey":"wix-order:<WIX_ORDER_ID>","reason":"Corrected pre-submit configuration"}'
```

It rejects pending, processing, sent, and `unknown_outcome` records.

`unknown_outcome` is deliberately terminal because a timed-out submit may still complete after a point-in-time operator check. A bare `confirmNoISendOrder` flag is not safe evidence and cannot authorize another submit. Reconcile these rows with iSend support using the stable Wix/customer order identity. If the order exists, durably record the mapping and sent state. If it does not, keep the row quarantined and use a provider-approved recovery; do not edit it back to pending/retry. Automated recovery can be added only after iSend confirms an authoritative lookup plus an idempotent create contract or a defined quiescence guarantee.

## Fulfillment Reconciliation

Fulfillment claims use keys shaped like `isend:<ISEND_ORDER_NO>:tracking:<TRACKING_NO>` in `ISendProcessedEvents`. Only `meta.status: completed` is safe to acknowledge. A `processing`, `unknown_outcome`, or missing/legacy status is deliberately terminal because Wix may have created the fulfillment even if the request failed or its response was lost.

When monitoring reports `fulfillment-reconciliation-required`:

1. Open the mapped Wix eCommerce order and inspect its fulfillments for that exact tracking number and the expected line items/quantities.
2. If the fulfillment exists, keep the claim and set `meta.status` to `completed`, recording who reconciled it and when.
3. If the fulfillment does not exist, confirm that absence from the authoritative Wix order/fulfillment view. Only then remove that one canonical claim (or create the fulfillment manually and mark it `completed`) so the next webhook/poller attempt can claim it again.
4. Never remove a `processing` or `unknown_outcome` claim merely to clear an alert. Preserve the evidence until the remote outcome is known.

Alert on any fulfillment claim that remains `processing` beyond the request timeout and on every `unknown_outcome`. The pending-email consumer must mark `ISendPendingEmails.sent=true` rather than delete delivered-email rows; deterministic IDs make repeated delivery reports reuse the same queue record.
