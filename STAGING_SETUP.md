# Wix + iStore iSend Staging Setup

Use this checklist before publishing or running the staging smoke test.

For workstation prerequisites, private `.env` setup, offline mock tests, and the direct read-only development login gate, complete [DEVELOPMENT_SETUP.md](DEVELOPMENT_SETUP.md) first.

## Wix Backend Secrets

Set these in Wix as backend-only secrets:

- `ISTORE_ISEND_ENV`: `staging`
- `ISTORE_ISEND_DEPLOYED_REVISION`: exact 40-character Git SHA of the backend source being published
- `ISTORE_ISEND_STORAGE_CLIENT_NO`
- `ISTORE_ISEND_API_USER_ID`
- `ISTORE_ISEND_API_PASSWORD`
- `ISTORE_ISEND_ORDER_ORIGIN`
- `ISTORE_ISEND_SANDBOX_URL`
- `ISTORE_ISEND_PRODUCTION_URL`
- `ISTORE_ISEND_WEBHOOK_SECRET`
- `ISTORE_ISEND_SINGLE_PARCEL_CONTRACT_CONFIRMED`: leave unset or set to a value other than `true` until the partner-approved single-parcel contract is recorded; fulfillment fails closed
- `ISEND_POLLER_TRIGGER_SECRET`
- `ISEND_FULFILLMENT_TRIGGER_SECRET`
- `ISEND_RECOVERY_TRIGGER_SECRET`

Production must set `ISTORE_ISEND_ENV` to `production`. The backend uses the production URL only when that environment is selected, and it never falls back from production to staging. New outbox rows and mappings persist that normalized environment. Workers fail closed when a durable record is missing the binding or does not match the current selector; changing the selector can no longer redirect old staging work to production. Set `ISTORE_ISEND_DEPLOYED_REVISION` to the exact reviewed 40-character source SHA before publishing that backend; operational health remains red when it is absent, malformed, or different from the capacity-evidence revision. Set `ISTORE_ISEND_SINGLE_PARCEL_CONTRACT_CONFIRMED` to exactly `true` only after the named approver records partner confirmation that each order has one complete parcel; missing, unreadable, or other values keep fulfillment disabled.

## Wix Data Collections

Create these collections with Admin-only read/write permissions before publishing the order worker:

- `ISendOrderOutbox` stores the complete Wix order snapshot and queue/lifecycle state. Add compound indexes on (`status`, `environment`, `nextAttemptAt`), (`status`, `environment`, `retryExhausted`), and (`status`, `environment`, `leaseExpiresAt`), plus a regular `lifecycleRequiresAttention` index. If the Wix plan supports it, add (`environment`, `lifecycleRequiresAttention`) for the health query; otherwise keep release blocked until target-site query-plan evidence proves the regular index is sufficient. Its deterministic item ID supplies the order-key identity boundary.
- `ISendOrderLifecycleIntents` stores append-only, environment-bound update/cancellation intents before a worker claim can be acquired. Add (`orderKey`, `environment`, `recordedAt` descending). Deterministic `_id` values deduplicate Wix events; no order snapshot or PII is stored.
- `ISendOrderOutboxClaims` stores append-only, generation-fenced worker leases. Add a compound index on (`claimKey` ascending, `generation` descending) and regular indexes on `leaseExpiresAt` and `releasedAt`. Before release, retain target-site query-plan evidence for both retention shapes: `releasedAt <= cutoff` with an `_id` keyset cursor/order, and empty `releasedAt` with `leaseExpiresAt <= cutoff`. If the Wix plan cannot serve either mixed predicate safely, add its supported compound index or redesign the cursor in a separately reviewed change; do not enable deletion.
- `ISendMaintenanceState` stores the retention scan cursor in the deterministic row `isend-claim-retention-cursor-v1`; no custom index is required because the job reads it by `_id`.
- `ISendOrderMap` maps Wix orders to iSend orders and schedules bounded status reconciliation. Add a regular index on `wixOrderId`, use the collection's single-field unique-index slot on `iSendOrderNo`, and add a compound regular index on (`environment`, `reconciliationActive`, `lastReconciledAt`). The deterministic mapping item ID already enforces one mapping per Wix order. Global iSend-number uniqueness is intentionally fail-closed until the partner confirms whether staging and production can reuse a `custOrderNo` and supplies an authenticated environment discriminator for webhooks.
- `ISendProcessedEvents` stores webhook and fulfillment idempotency records. Add a unique index on `idempotencyKey`; deterministic item IDs enforce new-code concurrency while the unique index also protects legacy auto-ID rows during rollout.
- `ISendWebhookEvents` stores environment-bound audit events; no custom index is prescribed.
- `ISendInventory` stores environment-bound inventory snapshots. Add a compound regular index on (`environment`, `sku`). Inventory polling remains disabled until the partner contract is approved.
- `ISendPendingEmails` stores environment-bound delivery-email records. Add (`environment`, `sent`, `createdAt`) for the operational-health objective.

The outbox, mapping, idempotency, raw-audit, delivery-side-effect, and inventory modules use deterministic Wix item IDs, so duplicate writes fail closed even before most custom indexes are available. Before creating the `ISendProcessedEvents.idempotencyKey` unique index, reconcile/remove any existing duplicate-key rows; the runtime strongly checks legacy rows, and the unique index closes the old/new deployment race.

Configure the worker and side-effect claim collections with these field types. Wix supplies its normal system fields in addition to these application fields.

| Collection | Field | Wix field type | Required purpose |
| --- | --- | --- | --- |
| `ISendOrderOutbox` | `orderKey`, `wixOrderId`, `status`, `environment`, `orderSnapshotFingerprint`, `latestOrderSnapshotFingerprint`, `wixLifecycleStatus`, `wixPaymentStatus`, `wixFulfillmentStatus`, `lastLifecycleEventId`, `cancellationReason`, `attentionReason`, `latestLifecycleIntentId` | Text | Stable identity, queue/lifecycle state, fingerprints, and immutable iSend environment binding |
| `ISendOrderOutbox` | `orderSnapshot`, `lastError`, `responseSummary`, `unknownOutcomeDetails`, `authoritativeOrderReadError` | Object | Durable order payload and bounded diagnostics |
| `ISendOrderOutbox` | `attemptCount`, `maxAttempts`, `claimGeneration` | Number | Retry and lease fencing counters |
| `ISendOrderOutbox` | `retryExhausted`, `lifecycleRequiresAttention` | Boolean | Terminal retry and durable lifecycle-attention guards |
| `ISendOrderOutbox` | `nextAttemptAt`, `leaseExpiresAt`, `enqueuedAt`, `updatedAt`, `sourceEventTime`, `lastAttemptStartedAt`, `lastAttemptFinishedAt`, `unknownOutcomeAt`, `sentAt`, `requeuedAt`, `lastLifecycleEventTime`, `lastLifecycleEventAt`, `canceledAt`, `lifecycleChangedDuringSubmitAt`, `authoritativeOrderReadAt`, `remediatedAt` | Date and Time | Scheduling, lease, lifecycle, authoritative-read, and audit timestamps |
| `ISendOrderOutbox` | `leaseToken`, `iSendOrderNo`, `unknownOutcomeReason`, `requeueReason`, `sourceEventId`, `sourceShape` | Text | Ownership, mapping, recovery, and source metadata |
| `ISendOrderLifecycleIntents` | `orderKey`, `wixOrderId`, `environment`, `intentType`, `wixOrderStatus`, `wixPaymentStatus`, `orderSnapshotFingerprint`, `sourceEventId` | Text | Required identity/environment/intent plus nullable lifecycle evidence |
| `ISendOrderLifecycleIntents` | `sourceEventTime`, `recordedAt` | Date and Time | Source and durable-receipt timestamps; `recordedAt` is required |
| `ISendOrderOutboxClaims` | `claimKey`, `orderKey`, `leaseToken` | Text | Lease identity and ownership |
| `ISendOrderOutboxClaims` | `generation` | Number | Numeric descending sort and monotonic fencing; do not configure this as Text |
| `ISendOrderOutboxClaims` | `claimedAt`, `leaseExpiresAt`, `releasedAt` | Date and Time | Lease lifecycle and expiry queries |
| `ISendMaintenanceState` | `cursorId`, `lastRunErrorCode`, `capacityEvidenceRevision`, `capacityEvidenceEnvironment`, `sensitiveDataRetentionPolicyRevision` | Text | Retention cursor/error and attested evidence identities |
| `ISendMaintenanceState` | `lastRunDurationMs`, `lastRunScanned`, `lastRunDeleted`, `lastRunPreservedInvalid`, `lastRunPreservedUnverified`, `lastRunStaleUnreleased`, `lastRunEligibleDeferred`, `lastRunVerificationFailures`, `claimItemLimit`, `measuredUniqueClaimKeysPerDay`, `lifecycleIntentItemLimit`, `measuredLifecycleIntentRowsPerDay`, `webhookPayloadRetentionDays`, `sentEmailRetentionDays`, `terminalOutboxSnapshotRetentionDays`, `fulfillmentClaimResultRetentionDays` | Number | Retention/capacity measurements and approved retention periods |
| `ISendMaintenanceState` | `lastRunAttentionRequired`, `lastRunThrottled`, `lastRunRuntimeLimited`, `lastRunScanTruncated`, `sensitiveDataRetentionPolicyApproved`, `webhookPayloadRetentionEnforcedExternally`, `sentEmailRetentionEnforcedExternally`, `terminalOutboxSnapshotScrubEnforcedExternally`, `fulfillmentClaimResultScrubEnforcedExternally` | Boolean | Fail-closed retention, capacity, and PII-policy gates |
| `ISendMaintenanceState` | `lastRunAttentionReasons`, `cycleAttentionReasons`, `capacityEvidenceProvenance`, `sensitiveDataRetentionPolicyProvenance` | Object | Bounded reasons and retained provenance |
| `ISendMaintenanceState` | `cycleStartedAt`, `lastCycleCompletedAt`, `lastRunAt`, `lastCutoff`, `capacityEvidenceMeasuredAt`, `sensitiveDataRetentionLastVerifiedAt`, `updatedAt` | Date and Time | Retention cycle and attestation timestamps |
| `ISendOrderMap` | `wixOrderId`, `iSendOrderNo`, `environment` | Text | Stable Wix-to-iSend identity and immutable environment binding |
| `ISendOrderMap` | `meta` | Object | Latest status and partner metadata |
| `ISendOrderMap` | `reconciliationActive` | Boolean | Include only non-terminal mappings in the scheduled safety net |
| `ISendOrderMap` | `createdAt`, `lastReconciledAt` | Date and Time | Stable manual pagination and oldest-attempted scheduling |
| `ISendProcessedEvents` | `idempotencyKey` | Text | Webhook or canonical fulfillment key |
| `ISendProcessedEvents` | `meta` | Object | Fulfillment state and bounded result/failure metadata |
| `ISendProcessedEvents` | `createdAt`, `updatedAt` | Date and Time | Claim lifecycle timestamps |
| `ISendWebhookEvents` | `deliveryId`, `environment`, `eventType` | Text | Environment-scoped delivery identity and audit event type |
| `ISendWebhookEvents` | `payload` | Object | Authenticated raw event payload |
| `ISendWebhookEvents` | `processedAt` | Date and Time | Audit processing timestamp |
| `ISendInventory` | `environment`, `sku` | Text | Environment-bound inventory identity |
| `ISendInventory` | `lastKnownQty` | Number | Latest webhook-reported available quantity |
| `ISendInventory` | `updatedAt` | Date and Time | Inventory observation timestamp |
| `ISendPendingEmails` | `to`, `subject`, `body`, `wixOrderId`, `iSendOrderNo`, `environment`, `source` | Text | Recipient, message, order identity, environment, and source |
| `ISendPendingEmails` | `createdAt` | Date and Time | Delivery-email queue timestamp |
| `ISendPendingEmails` | `sent` | Boolean | Wix Automation completion marker |

The compound `ISendOrderOutboxClaims` index must use `claimKey` ascending then numeric `generation` descending; `nextAttemptAt`, `leaseExpiresAt`, and `releasedAt` must remain Date and Time fields because workers and retention sort or compare them. Changing those fields to Text can make generations sort lexically after 9 or make due/expired queries incorrect. The same append-only claim collection also serializes mutations of one mapping under the namespaced key `isend-mapping:<iSendOrderNo>`, preventing a webhook and poller from replacing each other's full Wix Data item update.

Before adding the global unique `ISendOrderMap.iSendOrderNo` index, export the mappings and run two independent checks: group by `iSendOrderNo`, then separately group by `wixOrderId`. Manually reconcile every duplicate to one authoritative Wix/iSend pair; do not delete a record until its outbox, fulfillment, delivery-email, and partner evidence agree. Index creation must not be used as the duplicate detector because Wix can reject the build without resolving the underlying operational ambiguity.

Before publishing, export `ISendProcessedEvents` and complete two distinct migrations. First group legacy fulfillment keys shaped like `isend:<custOrderNo>:tracking:<trackingNo>` and the prior unscoped key `isend:<custOrderNo>:single-parcel-fulfillment` by `custOrderNo`. The runtime now permits one environment-scoped order-level claim only: `isend:<environment>:<custOrderNo>:single-parcel-fulfillment`. Convert a group only when it has exactly one conclusively completed claim whose environment is proven and whose stored Wix order ID, tracking number, and request fingerprint match the authoritative fulfillment and its full line-item/quantity request; preserve that metadata and result under the new key. Quarantine any group with multiple old tracking keys, an unproven environment, missing/mismatched fingerprint, `processing`, `unknown_outcome`, missing, or ambiguous status. Reconcile it against Wix and do not publish until resolved. If a new key already exists, require exact metadata agreement and retain one authoritative row rather than overwriting evidence.

Second, rows whose `meta.eventType` proves they are legacy raw-webhook claims must be assigned an environment from deployment and evidence appropriate to the event: matching audit evidence for status, mapped-order plus fulfillment/tracking evidence for tracking, or provider/inventory evidence for inventory. Change their key from the old delivery key to `<environment>:<old-key>` and record `meta.environment`. Leave ambiguous rows quarantined and keep webhook intake disabled. Do not prefix the new order-level fulfillment key or a non-webhook recovery claim. Re-run the duplicate-key check after both migrations and before creating the unique index.

Claim generations are append-only during normal processing to prevent lease ID reuse. The daily retention job deletes at most 500 explicitly released, expired, nonlatest generations after a configurable safety interval that defaults to 7 days. It scans at most 1,000 rows with strong reads, always preserves the highest numeric generation for every `claimKey`, and fails closed on missing/invalid identity, generation, or lifecycle fields. Unreleased or unexpired claims are never selected for deletion. A persisted `_id` keyset cursor in `ISendMaintenanceState` prevents permanently preserved latest rows from starving later pages; a completed pass clears the cursor for the next cycle. Never manually delete the latest row, because that would reset monotonic fencing.

`src/backend/jobs.config` runs the hourly outbox worker at minute 0, a five-mapping status reconciliation safety net at minute 30, hourly operational health at minute 45, and claim retention daily at 18:15 UTC (02:15 MYT). Only the outbox and poller make iSend calls, and only inside 10:00-22:00 MYT. The outbox and poller each have at most 60 productive work slots per service-window day before retries, starting backlog, and slow upstream calls consume capacity. Retention has nominal daily deletion capacity of 500 rows and scan capacity of 1,000 rows. These are bounds, not evidence; validate all runtimes, request budgets, storage occupancy/runway, and Wix limits with the exact-SHA capacity checker before production.

Before enabling claim retention, export `ISendOrderOutboxClaims`, verify the `releasedAt` index and the `ISendMaintenanceState` field types/permissions, and retain the export as recovery evidence. In a controlled staging backend invocation, seed one claim key with two released generations older than 7 days plus a latest generation, one unexpired claim, one unreleased claim, and one recently released claim. Run `cleanupISendClaimGenerations({ dryRun: true })`, retain the summary, then run the real cleanup. Prove only the old nonlatest generation was removed, the latest/active/unreleased/recent rows remain, the cursor advances or completes, and the scheduled job log is green. `ISendClaimRetentionCapacityError` exposes the exact failed reason in `summary.attentionReasons`, including `retention-delete-capacity` or `retention-cycle-incomplete`; either requires an alert plus backlog review.

Deletion throughput does not remove the required latest generation for each distinct `claimKey`, and lifecycle intents are append-only. Measure unique claim-key growth, total claim-row generation, lifecycle-intent rows/day, current occupancy, and the actual Wix plan limits during staging. Production authorization requires at least the checker’s safety-margin runway for both collections or a separately reviewed storage/fencing design; do not infer runway from nominal schedules.

Raw `ISendWebhookEvents.payload` records, sent `ISendPendingEmails`, terminal `ISendOrderOutbox.orderSnapshot`/diagnostic objects, and completed fulfillment-claim `ISendProcessedEvents.meta.result` records can contain sensitive data. No deletion or scrubbing interval is hard-coded because the owner must approve the retention periods and enforcement mechanism. Record all four periods, policy revision, recent verification, and provenance in `ISendMaintenanceState`; operational health remains red unless webhook/email enforcement and terminal-outbox/fulfillment-result scrubbing are explicitly attested. Terminal outbox scrubbing must preserve identifiers, state, fingerprints, and timestamps and must never touch `pending`, `processing`, `retry`, `unknown_outcome`, or `lifecycleRequiresAttention=true` records. Fulfillment-claim scrubbing must preserve the idempotency key, `meta.status`, request fingerprint, and reconciliation evidence needed to prevent a duplicate fulfillment. Never delete unsent email, an idempotency claim, ambiguous fulfillment, or other active evidence merely to satisfy retention.

Signed webhooks are the primary status path. Register only signed tracking and order-status events for this release; do not subscribe inventory until its payload/endpoint contract and legacy data are accepted. Event routing comes only from signed body fields `eventType`/`type`; delivery dedupe comes only from signed `deliveryId`/`eventId`, with a SHA-256 hash of the signed body as fallback. Unsigned `X-ISEND-Event` and `X-ISEND-Delivery-Id` headers are ignored. The scheduled poller is a safety net for missed events, not permission to omit webhook registration. It selects only current-environment `reconciliationActive=true` rows in oldest-`lastReconciledAt` order, leaves outside-window skips in place, and stops polling a terminal mapping only after required status/delivery/fulfillment effects complete. The protected manual poll endpoint uses those same fixed five-mapping, one-page, reconciliation-only bounds regardless of request-body options. A business-success query must report authoritative `returnObject.totalRecord=1`, return exactly one page row, and have that row's `custOrderNo` match the selected mapping before any status or tracking value can touch Wix. Missing or non-unit totals, empty/extra page rows, and mismatched identities fail the job. Signed tracking/status webhooks likewise must carry `custOrderNo` or the documented `customerOrderNo` alias; an internal `orderNo` alone is rejected. Webhook delivery claims are scoped by the configured environment. Status transitions are monotonic: delayed nonterminal events cannot regress later progress, `CANCELLED`/`RETURNED` are final, and only `RETURNED` may follow `DELIVERED`. A first valid tracking number remains eligible when its accompanying nonterminal status is ignored as stale, but effective `CANCELLED`/`RETURNED` blocks fulfillment and email. Pre-upgrade mappings are classified only after an environment has been assigned.

Outbound order submission also fails closed before login when identity, line items, SKUs, positive quantities/totals, non-negative prices, or required delivery contact/address fields are missing. Fully zero-total orders remain blocked until iSend confirms their contract; a zero-priced promotional line is allowed only inside a positive-total order.

Deterministic payload validation failures become retry-exhausted after the first attempt and preserve bounded field-level errors for operators. Replaying the same immutable snapshot cannot repair it: correct the authoritative order data and use a reviewed replacement/remediation path before any requeue.

## Environment Migration And Cutover

Do not infer a missing durable-record environment from the current secret. Before the first publication of this version, inventory every existing row in `ISendOrderOutbox`, `ISendOrderMap`, `ISendWebhookEvents`, `ISendInventory`, and `ISendPendingEmails`, plus the raw-webhook claims described above:

1. Prove each row's origin from deployment records and upstream evidence.
2. Backfill `environment=staging` only where that provenance is conclusive; use `production` only for proven production records.
3. Leave ambiguous rows quarantined and resolve them manually. The outbox and scheduled poller intentionally remain red and make no iSend request for unassigned outbox/mapping rows; keep webhook intake, inventory intake, or the email automation disabled for ambiguous side-effect rows.
4. Confirm every active environment-sensitive row has a binding before enabling its schedule, intake, or automation. Legacy side-effect IDs are stable, so a duplicate current write will not self-heal a missing `environment` field.

Before changing `ISTORE_ISEND_ENV` from staging to production, stop new staging intake and quiesce the staging webhook sender. Resolve all staging outbox attention states, require no staging row in `pending`, `processing`, or retryable `retry`, and require every staging mapping to have `reconciliationActive=false`. Retain a redacted export proving those conditions. After the selector change, both jobs must show zero missing/other-environment conflicts before the production canary is placed.

## Multi-Parcel Fulfillment Contract

Multi-parcel fulfillment is a go-live blocker. Obtain an iSend response/webhook contract that allocates each unique tracking number to specific Wix eCommerce line-item IDs and quantities, then verify that allocation with a real staging order. A tracking-number list without line-item allocation is not sufficient because the same Wix line item cannot be fulfilled once for every parcel.

Until that contract is implemented, the integration fails closed when a payload contains more than one unique tracking number. The webhook returns HTTP 409 with code `unsupported-multi-tracking`, and the poller returns `success: false` with a per-mapping `tracking-allocation` failure. Neither path reads the Wix order or creates a fulfillment for that update.

The protected `createFulfillmentFromWix` endpoint is subject to the same prohibition: it requires the mapped `iSendOrderNo` and one tracking number, derives the configured environment, fetches the authoritative Wix order, and uses every current line-item ID/quantity under the one order-level single-parcel claim. Any supplied line-item assertion must match the full authoritative set. It rejects arbitrary caller-selected idempotency keys, so an untracked, partial, or second request cannot consume or bypass the one-parcel boundary.

## Local Staging Smoke Test

Set these local environment variables when testing from your machine:

- `ISTORE_ISEND_API_USER_ID`
- `ISTORE_ISEND_API_PASSWORD`
- `ISTORE_ISEND_SANDBOX_URL`
- `ISTORE_ISEND_STORAGE_CLIENT_NO`
- `WIX_SITE_BASE_URL`
- `ISEND_POLLER_TRIGGER_SECRET`

Use an HTTPS iStore/iSend host root or `/IsisWMS-War` context root for `ISTORE_ISEND_SANDBOX_URL`. The backend appends `/Json/...` paths and automatically tries the `/IsisWMS-War` context root when the configured URL is host-only. One owner-approved private staging origin uses `/api/login`; that exception is authorized only when the environment is staging and the origin matches the reviewed SHA-256 fingerprint recorded in code. Public staging origins and every production origin reject `/api/login`. Both backend and smoke tooling reject URL credentials, query strings, fragments, other paths, HTTP, and hosts/ports outside the environment-specific allowlist. Redirect responses are rejected so credentials and order data cannot be forwarded to another destination.

Verified official context roots:

- Staging: `https://staging.istoreisend-wms.com:5191/IsisWMS-War`
- Production: `https://istoreisend-wms.com:5191/IsisWMS-War`
- Alternate staging/test web API host: `https://webapi.istoreisend-wms.com/IsisWMS-War`

Outbound order timestamps are serialized explicitly in `Asia/Kuala_Lumpur` time rather than inheriting the Wix or developer-machine timezone. The backend's 20-second deadline covers both the request and response-body read and aborts the underlying fetch when the deadline expires.

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
- Published Wix endpoint check at `/_functions/testISendLoginFromWix`. The script sends `ISEND_POLLER_TRIGGER_SECRET` as `X-ISEND-POLLER-SECRET`; the endpoint runs only when the site's authoritative `ISTORE_ISEND_ENV` is staging, ignores caller environment/force overrides, redacts the upstream root, and must report authenticated-session evidence.
- Direct inventory query when `--inventory` is provided; it logs in first and sends the returned iSend session cookie/session fields with the inventory request.

It does not print secret values or configured hostnames, including in DNS/TLS/socket errors. Live probes are skipped outside the configured 10:00 AM-10:00 PM Malaysia Time service window. `--force` may run the direct iSend login/inventory probe intentionally, but it never bypasses the protected Wix diagnostic's service-window gate.

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
- `skipped: true` with `Outside iStore iSend service window`: the command did not call that endpoint because the current Malaysia Time is outside the configured staging window. Run again during the window; `--force` is limited to the direct iSend login/inventory probe and cannot force the Wix diagnostic.
- `ISTORE_ISEND_SANDBOX_URL host and port are not in the approved iStore iSend allowlist`: replace it with one of the exact staging roots above. `WIX_SITE_BASE_URL` is the separate setting for the published Wix site and must also use HTTPS.
- `connect ETIMEDOUT [address]` on `direct-isend-staging`: the configured iSend staging host is not reachable from the local network on its configured port. Check VPN, firewall, allowlist, endpoint host, and whether the iSend staging service is up.
- `Wix staging iSend endpoint failed with status 404`: `WIX_SITE_BASE_URL` is reachable, but the published site at that URL does not expose `/_functions/testISendLoginFromWix`. Check that the URL points to the intended Wix site/environment and that the backend code is published there.
- `Wix staging iSend endpoint failed with status 401` or `503`: the protected diagnostic header does not match the Wix Backend Secret, or `ISEND_POLLER_TRIGGER_SECRET` is not configured in Wix.
- `unable to verify the first certificate`: on Windows, retry with Node's system certificate store, for example `NODE_OPTIONS=--use-system-ca npm run check:staging`.
- The default local smoke-test timeout is 20 seconds. Override it with `CHECK_ISEND_TIMEOUT` or `--timeout` when diagnosing slow networks.

`npm run check:staging:diagnose` reports Wix route status codes and iSend port reachability without printing the configured hostnames or secrets. It cannot bypass the Wix diagnostic's configured-staging or service-window gates.

## GitHub Actions

The repository intentionally has no GitHub Actions workflows. Live staging proof is collected from the owner-approved local or Wix-side smoke commands in this runbook, during the 10:00-22:00 MYT service window, and retained as redacted evidence. Do not reintroduce a workflow without a separate approval and capacity-model update.

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

The single-parcel fulfillment claim uses one environment-scoped order-level key shaped like `isend:<ENVIRONMENT>:<ISEND_ORDER_NO>:single-parcel-fulfillment` in `ISendProcessedEvents`. Only `meta.status: completed` with an exact stored request fingerprint is safe to acknowledge. A different tracking number produces a fingerprint mismatch instead of authorizing a second parcel. A `processing`, `unknown_outcome`, missing/legacy status, or completed fingerprint mismatch is deliberately terminal because Wix may have created the fulfillment even if the request failed or its response was lost.

When monitoring reports `fulfillment-reconciliation-required`:

1. Open the mapped Wix eCommerce order and inspect all fulfillments for the claim's exact tracking number and expected line items/quantities.
2. If the one expected fulfillment exists, keep the order-level claim and set `meta.status` to `completed`, preserving the matching order ID, tracking number, and request fingerprint and recording who reconciled it and when.
3. If no fulfillment exists, confirm that absence from the authoritative Wix order/fulfillment view. Only then remove that one order-level claim (or create the single fulfillment manually and mark it `completed`) so the next webhook/poller attempt can claim it again.
4. Never remove a `processing` or `unknown_outcome` claim merely to clear an alert. Preserve the evidence until the remote outcome is known.

Alert on any fulfillment claim that remains `processing` beyond the request timeout and on every `unknown_outcome`. The pending-email consumer must mark `ISendPendingEmails.sent=true` rather than delete delivered-email rows; deterministic IDs make repeated delivery reports reuse the same queue record.
