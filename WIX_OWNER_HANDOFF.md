# Wix Owner Handoff Runbook

This runbook covers the owner-only work required after the current iStore/iSend pull request is reviewed and merged into `main`. It moves that exact source revision into the connected Wix site. Complete the staging gates in order. Do not enable production submission until every production gate is signed off.

The connected Wix site ID is recorded in `wix.config.json`. Before changing the site, authenticate with `npx wix login`, confirm the expected account with `npx wix whoami`, and verify that the CLI is targeting that site.

## Deployment Record

Record the evidence here or in the team's controlled change record. Do not record secret values.

| Item | Evidence to retain |
| --- | --- |
| Source revision | Full commit SHA from `main` |
| Wix target | Site ID and owner account |
| Preview | Preview URL and reviewer approval |
| Publication | Publish timestamp and Wix deployment/build result |
| Strict staging probe | Redacted local or Wix-side diagnostic command output and result |
| Staging canary | Wix order ID, iSend `custOrderNo`, tracking number, and timestamps |
| Production authorization | Named approver and partner-contract references |

## Owner And Partner Unblock Checklist (Backend Staging Only)

Do not put secret values in this document, chat, tickets, screenshots, or retained command output.

| Owner/partner action | Why it is required | Engineering verification after delivery |
| --- | --- | --- |
| Owner explicitly authorizes Admin-only read/write permissions and creation/repair of all nine Wix integration collections, fields, and indexes. | The two existing collections currently expose content to Everyone; required lifecycle, mapping, idempotency, audit, inventory, email, maintenance, and index state is incomplete. | Compare every hosted collection ID, field type, permission, item count/migration, and active index to this manifest. |
| Owner securely provisions all seventeen Wix secret names, binds `ISTORE_ISEND_DEPLOYED_REVISION` to the exact source SHA being published, and keeps `ISTORE_ISEND_SINGLE_PARCEL_CONTRACT_CONFIRMED` unset/non-`true` until partner approval. | Webhook authentication, protected poll/fulfillment/recovery routes, environment selection, capacity-evidence binding, and single-parcel fulfillment fail closed without them. | Verify names, selected staging environment, and deployed-revision equality without displaying credential values; test authorized/unauthorized route behavior. |
| Owner preserves the private local and Wix staging diagnostic inputs and confirms their staging-scoped values through the strict live probe. | Read-only source inspection proves only required names, not values or target correctness. | Run the owner-approved local or Wix-side probe during the MYT window and retain redacted direct/Wix authenticated-session evidence. |
| Network/iSend owner makes the reviewed staging endpoint reachable from the approved runner, including any source-IP/firewall allowlist. | Direct login and inventory currently time out from this runner. | Repeat redacted reachability, login, and inventory checks inside the service window. |
| Partner confirms `custOrderNo` create/query/webhook semantics, uniqueness scope, signed-body fields/HMAC rules, event ordering, and request/concurrency limits. | Mapping, dedupe, monotonic status, and capacity must use authoritative identities and limits rather than inference. | Validate real redacted create/query/webhook shapes, identity-mismatch rejection, replay, delayed-event handling, and capacity headroom. |
| Partner approves the one-complete-parcel contract or supplies an allocation contract mapping every tracking number to Wix line-item IDs/quantities. | Fulfillment is deliberately disabled until this is proven; multi/contradictory parcel evidence fails closed. | Prove one-parcel success/idempotent replay and rejection of multiple, contradictory, partial, or sequential second tracking cases without a second fulfillment. |
| Partner defines the post-submit cancel/void/update API, idempotency/reconciliation semantics, and operator SLA. | A Wix cancellation after a successful or ambiguous iSend submit cannot safely be translated today. | Prove pre-submit cancellation/refund makes no iSend request and post-submit changes remain durable attention until the reviewed contract exists. |
| Owner approves retention periods and external enforcement for webhook payloads, sent emails, terminal outbox snapshots/diagnostics, and completed fulfillment-claim results, with an accountable approver, policy revision, and evidence location. | These records may contain sensitive data; engineering will not guess retention periods, delete idempotency claims, or scrub active/ambiguous evidence. | Record all four attestations in `ISendMaintenanceState`, verify enforcement and evidence age, and prove operational health stays red when any attestation is absent/stale. |
| Owner configures Wix Monitoring recipients and escalation ownership. | A failed job is not an alert until an accountable person receives it. | Trigger controlled staging lifecycle, fulfillment, retry, retention, capacity, and policy failures and retain delivery/recovery proof. |
| Owner authorizes publishing one exact reviewed commit to the Wix staging backend only after every prerequisite above passes. | Current hosted routes/jobs do not contain this audited backend. | Verify Wix build SHA, routes, seven lifecycle handlers, four schedules, schema, secrets, alerts, and strict staging scenarios. No frontend content is in scope. |

## 1. Provision Backend Secrets

Create or verify these exact names in Wix Secrets Manager as backend-only secrets. Values must be supplied through the owner-approved secret channel and must not be added to this repository, a ticket, or a deployment log.

- `ISTORE_ISEND_ENV`
- `ISTORE_ISEND_DEPLOYED_REVISION`
- `ISTORE_ISEND_STORAGE_CLIENT_NO`
- `ISTORE_ISEND_API_USER_ID`
- `ISTORE_ISEND_API_PASSWORD`
- `ISTORE_ISEND_ORDER_ORIGIN`
- `ISTORE_ISEND_SANDBOX_URL`
- `ISTORE_ISEND_PROD_STORAGE_CLIENT_NO`
- `ISTORE_ISEND_PRODUCTION_API_USER_ID`
- `ISTORE_ISEND_PRODUCTION_API_PASSWORD`
- `ISTORE_ISEND_PRODUCTION_ORDER_ORIGIN`
- `ISTORE_ISEND_PRODUCTION_URL`
- `ISTORE_ISEND_WEBHOOK_SECRET`
- `ISTORE_ISEND_SINGLE_PARCEL_CONTRACT_CONFIRMED`
- `ISEND_POLLER_TRIGGER_SECRET`
- `ISEND_FULFILLMENT_TRIGGER_SECRET`
- `ISEND_RECOVERY_TRIGGER_SECRET`

Keep the environment selector on the staging environment through staging acceptance. Set `ISTORE_ISEND_DEPLOYED_REVISION` to the exact reviewed 40-character source SHA being published; operational health rejects a missing, malformed, or capacity-evidence-mismatched value. The poller credential may be shared with the staging monitor, but the fulfillment and recovery credentials are separate operator credentials. In particular, never give `ISEND_RECOVERY_TRIGGER_SECRET` to an automated poller or monitor.

The protected fulfillment endpoint is not a split-shipment escape hatch. It requires the mapped `iSendOrderNo` and one tracking number, reads the full authoritative Wix order inside the single-parcel coordinator, and rejects partial line-item assertions or caller-selected keys. Leave `ISTORE_ISEND_SINGLE_PARCEL_CONTRACT_CONFIRMED` unset or non-`true` until the named approver records partner confirmation that every order has one complete parcel; missing, unreadable, or other values fail closed. Set it to exactly `true` only with that evidence.

The local live probe requires these exact private inputs:

- `ISTORE_ISEND_API_USER_ID`
- `ISTORE_ISEND_API_PASSWORD`
- `ISTORE_ISEND_SANDBOX_URL`
- `WIX_SITE_BASE_URL`
- `ISEND_POLLER_TRIGGER_SECRET`

Acceptance:

- Wix reports all seventeen backend secret names present.
- The staging environment is selected.
- The local smoke configuration reports all five live-probe input names present when required.
- No secret value appears in source, command output retained as evidence, or screenshots.

## 2. Provision Wix Data

Create all nine collections below. Set content permissions to Admin-only read and Admin-only write. Wix supplies its normal system fields, including `_id`; create the application fields with the exact keys and types shown.

### `ISendOrderOutbox`

| Type | Field keys |
| --- | --- |
| Text | `orderKey`, `wixOrderId`, `status`, `environment`, `leaseToken`, `iSendOrderNo`, `unknownOutcomeReason`, `requeueReason`, `sourceEventId`, `sourceShape`, `orderSnapshotFingerprint`, `latestOrderSnapshotFingerprint`, `wixLifecycleStatus`, `wixPaymentStatus`, `wixFulfillmentStatus`, `lastLifecycleEventId`, `cancellationReason`, `attentionReason`, `latestLifecycleIntentId` |
| Object | `orderSnapshot`, `lastError`, `responseSummary`, `unknownOutcomeDetails`, `authoritativeOrderReadError` |
| Number | `attemptCount`, `maxAttempts`, `claimGeneration` |
| Boolean | `retryExhausted`, `lifecycleRequiresAttention` |
| Date and Time | `nextAttemptAt`, `leaseExpiresAt`, `enqueuedAt`, `updatedAt`, `sourceEventTime`, `lastAttemptStartedAt`, `lastAttemptFinishedAt`, `unknownOutcomeAt`, `sentAt`, `requeuedAt`, `lastLifecycleEventTime`, `lastLifecycleEventAt`, `canceledAt`, `lifecycleChangedDuringSubmitAt`, `authoritativeOrderReadAt`, `remediatedAt` |

Indexes:

- Compound index on `status`, then `environment`, then `nextAttemptAt`.
- Compound index on `status`, then `environment`, then `leaseExpiresAt`.
- Regular index on `lifecycleRequiresAttention`. Wix's three-regular-index limit is satisfied by the two queue indexes above plus this health index. The retry-exhausted health query must be scoped to the current environment and use the status/environment prefix of the queue indexes; mismatch and unassigned scans cover other environment states.

The `status` field now also uses `canceled`. Fingerprints are lowercase SHA-256 hex. The lifecycle and attention fields are nullable except where a new order row records its initial fingerprint/event timestamps.

### `ISendOrderLifecycleIntents`

| Type | Field keys |
| --- | --- |
| Text | `orderKey`, `wixOrderId`, `environment`, `intentType`, `wixOrderStatus`, `wixPaymentStatus`, `orderSnapshotFingerprint`, `sourceEventId` |
| Date and Time | `sourceEventTime`, `recordedAt` |

Index:

- Compound index on `orderKey`, then `environment`, then `recordedAt` descending.

`orderKey`, `wixOrderId`, `environment`, `intentType`, and `recordedAt` are required. `intentType` is `update` or `cancellation`; the remaining fields are nullable. Deterministic `_id` values deduplicate Wix event delivery. This append-only collection stores no order snapshot or other PII, but it has no automatic deletion path; production requires measured item occupancy and at least the accepted storage runway.

### `ISendOrderOutboxClaims`

| Type | Field keys |
| --- | --- |
| Text | `claimKey`, `orderKey`, `leaseToken` |
| Number | `generation` |
| Date and Time | `claimedAt`, `leaseExpiresAt`, `releasedAt` |

Indexes:

- Compound index on `claimKey` ascending, then numeric `generation` descending, in that order.
- Regular index on `leaseExpiresAt`.
- Regular index on `releasedAt`.

`generation` must be Number, never Text. Claim generations are append-only during normal processing. In addition to outbox worker leases, this collection stores namespaced `isend-mapping:<iSendOrderNo>` leases that serialize webhook and poller mapping updates. Daily retention removes only explicitly released, expired, nonlatest generations older than the configured interval; the highest generation for every `claimKey`, every unexpired claim, and every unreleased claim is preserved. Before enabling deletion, retain target-site query-plan evidence for `releasedAt <= cutoff` with an `_id` keyset cursor/order and for empty `releasedAt` with `leaseExpiresAt <= cutoff`. If the Wix plan cannot serve either mixed predicate safely, add a supported compound index or redesign the cursor under separate review; keep retention and release blocked.

### `ISendMaintenanceState`

| Type | Field keys |
| --- | --- |
| Text | `cursorId`, `lastRunErrorCode`, `capacityEvidenceRevision`, `capacityEvidenceEnvironment`, `sensitiveDataRetentionPolicyRevision` |
| Number | `lastRunDurationMs`, `lastRunScanned`, `lastRunDeleted`, `lastRunPreservedInvalid`, `lastRunPreservedUnverified`, `lastRunStaleUnreleased`, `lastRunEligibleDeferred`, `lastRunVerificationFailures`, `claimItemLimit`, `measuredUniqueClaimKeysPerDay`, `lifecycleIntentItemLimit`, `measuredLifecycleIntentRowsPerDay`, `webhookPayloadRetentionDays`, `sentEmailRetentionDays`, `terminalOutboxSnapshotRetentionDays`, `fulfillmentClaimResultRetentionDays` |
| Boolean | `lastRunAttentionRequired`, `lastRunThrottled`, `lastRunRuntimeLimited`, `lastRunScanTruncated`, `sensitiveDataRetentionPolicyApproved`, `webhookPayloadRetentionEnforcedExternally`, `sentEmailRetentionEnforcedExternally`, `terminalOutboxSnapshotScrubEnforcedExternally`, `fulfillmentClaimResultScrubEnforcedExternally` |
| Object | `lastRunAttentionReasons`, `cycleAttentionReasons`, `capacityEvidenceProvenance`, `sensitiveDataRetentionPolicyProvenance` |
| Date and Time | `cycleStartedAt`, `lastCycleCompletedAt`, `lastRunAt`, `lastCutoff`, `capacityEvidenceMeasuredAt`, `sensitiveDataRetentionLastVerifiedAt`, `updatedAt` |

No custom index is required. The retention and health jobs read and update the deterministic `_id` `isend-claim-retention-cursor-v1`. The keyset cursor must remain Admin-only; it advances bounded scans past preserved latest rows and resets to empty after a complete cycle. Capacity and sensitive-data-retention fields must come from retained, owner-approved evidence; never populate them with estimates merely to clear health. Terminal outbox scrubbing must preserve queue identifiers, state, fingerprints, and timestamps and must exclude active, retryable, ambiguous, or lifecycle-attention rows. Completed fulfillment-claim result scrubbing must preserve the idempotency key, `meta.status`, request fingerprint, and reconciliation evidence; never delete the claim itself.

### `ISendOrderMap`

| Type | Field keys |
| --- | --- |
| Text | `wixOrderId`, `iSendOrderNo`, `environment` |
| Object | `meta` |
| Boolean | `reconciliationActive` |
| Date and Time | `createdAt`, `lastReconciledAt` |

Indexes:

- Regular index on `wixOrderId`.
- Unique index on `iSendOrderNo`.
- Compound regular index on `environment`, then `reconciliationActive`, then `lastReconciledAt`, in that order.

Before adding the global unique `iSendOrderNo` index, export the rows and run two independent duplicate checks: first group by `iSendOrderNo`, then separately group by `wixOrderId`. Manually reconcile each duplicate group to one authoritative Wix/iSend pair using outbox, fulfillment, email, and partner evidence. Do not delete an active or ambiguous mapping merely to make the index build pass.

### `ISendProcessedEvents`

| Type | Field keys |
| --- | --- |
| Text | `idempotencyKey` |
| Object | `meta` |
| Date and Time | `createdAt`, `updatedAt` |

Index:

- Unique index on `idempotencyKey`.

Before adding the unique index, find and reconcile any legacy rows with duplicate `idempotencyKey` values. Do not delete an active fulfillment claim merely to make the index build pass.

Complete both claim migrations below before publishing this version:

1. Group legacy fulfillment keys shaped like `isend:<custOrderNo>:tracking:<trackingNo>` and the prior unscoped key `isend:<custOrderNo>:single-parcel-fulfillment` by `custOrderNo`. The current single-parcel boundary uses exactly one environment-scoped order-level key, `isend:<environment>:<custOrderNo>:single-parcel-fulfillment`. Convert a group only when it contains exactly one authoritative claim, its environment is proven, its status is conclusively `completed`, and its `meta.orderId`, `meta.trackingNumber`, and `meta.requestFingerprint` match the one Wix fulfillment and its complete line-item/quantity request. Preserve those fields and the completed result when changing the key. If the order has more than one legacy tracking claim, an unproven environment, a missing/mismatched fingerprint, or a `processing`, `unknown_outcome`, missing, or ambiguous status, quarantine it and reconcile the Wix fulfillment before intake. Do not publish while any such group is unresolved. If the new key already exists, require exact metadata agreement and retain one authoritative row rather than overwriting either claim.
2. Identify legacy raw-webhook claims only where `meta.eventType` proves webhook origin. Prove the environment from deployment plus evidence appropriate to the event: matching audit evidence for status events, the mapped Wix order and canonical fulfillment/tracking evidence for tracking events, or provider/inventory evidence for inventory events. Change the key to `<environment>:<old-key>` and record `meta.environment`. Quarantine ambiguous claims and keep webhook intake disabled. Do not prefix the new single-parcel fulfillment key or other non-webhook recovery claims.

Re-run the duplicate-key check after both migrations, then create the unique index.

### `ISendWebhookEvents`

| Type | Field keys |
| --- | --- |
| Text | `deliveryId`, `environment`, `eventType` |
| Object | `payload` |
| Date and Time | `processedAt` |

No custom index is currently prescribed by the repository.

### `ISendInventory`

| Type | Field keys |
| --- | --- |
| Text | `environment`, `sku` |
| Number | `lastKnownQty` |
| Date and Time | `updatedAt` |

Index:

- Compound regular index on `environment`, then `sku`, in that order.

Inventory rows use a deterministic `_id` derived from environment and SKU so concurrent first deliveries cannot create multiple current-code rows. Inventory polling remains disabled until its partner contract is approved, but the collection is still needed if inventory webhooks are accepted. Reconcile any legacy duplicate environment/SKU rows before accepting inventory webhook events.

### `ISendPendingEmails`

| Type | Field keys |
| --- | --- |
| Text | `to`, `subject`, `body`, `wixOrderId`, `iSendOrderNo`, `environment`, `source` |
| Date and Time | `createdAt` |
| Boolean | `sent` |

Index:

- Compound index on `environment`, then `sent`, then `createdAt`.

Acceptance:

- All nine collection IDs match exactly, including capitalization.
- All nine collections are Admin-only for read and write.
- Every prescribed index is active, with the fields in the stated order.
- Date fields are not Text, counters are not Text, and Object payloads are not flattened into strings.
- Both `ISendOrderOutbox.environment` and `ISendOrderMap.environment` are Text fields.

### Existing-row environment migration

Before publishing, export and inventory existing rows in `ISendOrderOutbox`, `ISendOrderMap`, `ISendWebhookEvents`, `ISendInventory`, and `ISendPendingEmails`, as well as the raw-webhook claims identified above. Prove each row's originating environment from deployment, order, webhook, email, and iSend evidence appropriate to that row. Backfill `environment=staging` only for conclusively staging records, and `production` only for conclusively production records. Never assign an ambiguous row from the current value of `ISTORE_ISEND_ENV`; quarantine it and reconcile it manually.

This is mandatory for the three side-effect collections too: their stable legacy item IDs can make a current insert look like a harmless replay, so a duplicate write will not add a missing environment field. Unassigned outbox/mapping rows intentionally keep scheduled monitoring red without making an upstream request; ambiguous webhook, inventory, or email rows must keep the corresponding intake/automation disabled until reconciled.

## 3. Preview, Publish, and Verify Wix Runtime Activation

1. Confirm that the intended commit is present on remote `main`.
2. Create and review a Wix preview from the remote source.
3. Publish from the remote source with `npx wix publish --source remote`. Do not use `--force` to bypass build errors.
4. Retain the Wix build and publication result with the commit SHA.
5. In Wix, confirm that all lifecycle event handlers are active:
   - `wixEcom_onOrderApproved`
   - `wixEcom_onOrderUpdated`
   - `wixEcom_onOrderPaymentStatusUpdated`
   - `wixEcom_onOrderTransactionsUpdated`
   - `wixEcom_onOrderCanceled`
   - `wixStores_onNewOrder`
   - `wixStores_onOrderCanceled` (legacy compatibility only; the modern eCommerce handlers are authoritative)
6. Confirm that all scheduled jobs are active:
   - function location: `/isendOrderOutbox.js`
   - function name: `runISendOrderOutboxJob`
   - cron expression: `0 * * * *`
   - function location: `/isendPoller.js`
   - function name: `runISendPollerJob`
   - cron expression: `30 * * * *`
   - function location: `/isendClaimRetention.js`
   - function name: `runISendClaimRetentionJob`
   - cron expression: `15 18 * * *` (daily at 02:15 MYT)
   - function location: `/isendOperationalHealth.js`
   - function name: `runISendOperationalHealthJob`
   - cron expression: `45 * * * *`
7. Verify the protected staging diagnostic at `GET /_functions/testISendLoginFromWix` using header `X-ISEND-POLLER-SECRET`. A valid response must show authenticated-session evidence without exposing session values.

The outbox submits a bounded batch of five orders hourly, while the staggered poller reconciles five active mappings hourly as a webhook safety net. Both make iSend calls only inside 09:00-23:00 Malaysia Time. Claim retention makes no iSend request; it scans at most 1,000 old released claim rows and deletes at most 500 safe nonlatest rows per daily run. Operational health fails its hourly job on unresolved lifecycle, fulfillment, retention, capacity, or sensitive-data-policy state. A successful publication is not staging acceptance by itself.

### Stale packaged artifact

`isend-backend.zip` predates the reviewed implementation and is stale. Do not upload or deploy it as a substitute for publishing remote `main`. Keep the file in place for now; its deletion or regeneration requires a separate, explicit artifact-ownership decision.

## 4. Register the iSend Webhook

Register the published endpoint with the iSend owner:

- Method and URL: `POST https://<published-site>/_functions/isendWebhook`
- Signature header: `X-ISEND-Signature`
- Signature format: `sha256=<hex HMAC-SHA256>` over the exact raw request body
- Shared secret: the value stored under `ISTORE_ISEND_WEBHOOK_SECRET`
- Delivery identifier, when supported: signed body field `deliveryId` or `eventId`
- Event name: signed body field `eventType` or `type`

`X-ISEND-Delivery-Id` and `X-ISEND-Event` are not covered by the body HMAC and are intentionally ignored for dedupe and routing. If the signed body omits a delivery identifier, the handler uses its SHA-256 body hash. Subscribe only the signed tracking and order-status event families for this release. Do not subscribe inventory events yet; handler support does not replace the unresolved inventory payload/endpoint contract and migration gate.

Require iSend to retry retryable non-2xx responses. Confirm how it handles a temporary `503 mapping-not-ready` response. A `409 unsupported-multi-tracking` response is a deliberate contract stop, not permission to replay the payload without reconciliation.

Acceptance:

- A signed test event succeeds.
- A modified body with the original signature is rejected.
- A missing or invalid signature is rejected without processing side effects.
- Replaying the same delivery ID does not create a second fulfillment.

## 5. Configure the Pending-Email Automation

Create a Wix Automation triggered when an item is added to `ISendPendingEmails` with `sent=false`.

1. Send the record's `subject` and `body` to its `to` address.
2. Only after confirmed delivery to the email provider, update that same row to `sent=true`.
3. Do not delete delivered-email rows. Their deterministic IDs make repeated `DELIVERED` reports converge on the same record.
4. Alert on automation failure and on unsent rows older than the agreed delivery objective.

Test the automation with a controlled recipient before using a customer order.

## 6. Run the Strict Staging Probe

Run the local or Wix-side staging smoke probe from the exact reviewed source revision during 09:00-23:00 Malaysia Time. Retain redacted evidence in which:

- offline validation, lint, and all unit tests pass;
- the direct iSend login probe runs and passes;
- the published Wix login probe runs and passes;
- neither live probe is skipped; and
- the overall live result is `passed`, not `neutral` or `partial`.

Local preflight is:

```bash
npm run check:staging:setup -- --require-direct --require-wix
npm run check:staging
```

Local readiness does not replace Wix publication evidence.

## 7. Capture One End-to-End Single-Parcel Staging Order

Use one controlled, single-parcel Wix order. Before placing it, verify it has a positive order total, at least one line item, a nonblank SKU on every line, positive quantities, non-negative prices, and complete delivery contact/address data (name, phone, address line 1, city, postcode, state, and country). Retain redacted screenshots or exported records proving each transition:

1. The Wix event creates one `ISendOrderOutbox` row with the expected `wix-order:<WIX_ORDER_ID>` key.
2. The hourly worker submits exactly once and advances the row without an unexpected retry.
3. The successful create-order response contains `custOrderNo`.
4. `ISendOrderMap` contains the Wix order ID, `environment=staging`, and that same `custOrderNo` as `iSendOrderNo`.
5. A signed webhook supplies one tracking number and drives the normal update path.
6. Wix contains exactly one fulfillment with the expected line-item IDs, quantities, and tracking number.
7. The corresponding `ISendProcessedEvents` fulfillment claim has `meta.status=completed`.
8. After the one fulfillment is confirmed, a delivered tracking update changes mapping metadata, retains exactly one raw-delivery audit plus one distinct deterministic delivered-side-effect audit in `ISendWebhookEvents`, and creates exactly one `ISendPendingEmails` row. A status-only delivered event creates its raw audit but must not queue the delivered email until tracking has safely produced or confirmed the fulfillment.
9. The automation sends the controlled email and changes `sent` to `true`.
10. Replaying the webhook update does not duplicate the iSend submission, Wix fulfillment, either audit identity, or email.
11. Independently observe a scheduled `runISendPollerJob` execution. Retain evidence that it selects no more than five active mappings, advances `lastReconciledAt` after a real query, and sets `reconciliationActive=false` only after a terminal status and all required effects complete. The protected manual poller is diagnostic evidence, not a substitute for this scheduled-job check.
12. Retain the iSend query response showing authoritative `returnObject.totalRecord=1`, exactly one page row, and that row's exact `custOrderNo` equal to the selected mapping. Prove that a missing/non-unit total or empty, extra, or mismatched page response fails without a Wix order read, status update, or fulfillment.
13. After `DELIVERED`, replay an earlier signed nonterminal status/tracking delivery and prove the mapping does not regress and no extra fulfillment, audit row, or email is created. For a separate controlled record, prove `RETURNED` is accepted after `DELIVERED` and remains final against later replays.
14. On separate controlled orders, prove cancellation, full refund, and authoritative order changes before submit produce no iSend order. Prove a partial-refund state fails closed with durable attention.
15. Inject a cancellation/update while submission or mapping persistence is in progress. Prove the durable lifecycle intent is not lost and the resulting sent/ambiguous row requires operator attention; do not claim iSend cancellation without the partner contract.
16. Submit multi-tracking, contradictory parcel-count, empty-parcel, partial-line-item, and sequential second-tracking cases. Prove each fails nonretryably without a second Wix fulfillment.
17. On stable already-submitted orders, exercise cancellation, full refund, partial refund, and material order update. Prove each remains durable operator attention and no uncontracted iSend cancel/update is claimed.
18. Seed an authoritative Wix order with any already-fulfilled quantity and submit one tracking, then prove the coordinator rejects it without another fulfillment.
19. Remove the buyer/billing email on a controlled delivered order and prove delivery email processing fails retryably with `isend-delivery-email-missing`, the webhook remains unprocessed, the poller mapping stays active, and the configured alert is delivered.

Do not use a multiple-tracking order for this first acceptance test.

## 8. Reconciliation and Alerting

Configure alerts for:

- scheduled-job failure;
- any outbox `unknown_outcome`;
- any fulfillment claim with `meta.status=unknown_outcome`;
- fulfillment `processing` older than the request timeout;
- any outbox row with `lifecycleRequiresAttention=true`;
- retry exhaustion;
- deterministic outbound payload rejection;
- missing or current-selector-mismatched durable-record environment binding;
- queue age and backlog above the accepted threshold;
- invalid-signature spikes;
- Wix fulfillment failure;
- poller failure;
- claim-retention invalid/unverified rows, stale unreleased claims, throttling, partial bulk deletion, runtime limit, or incomplete cycle;
- claim and lifecycle-intent collection occupancy/runway;
- missing, stale, or mismatched exact-SHA capacity evidence;
- missing or stale owner-approved webhook/email enforcement or terminal-outbox/fulfillment-result scrub-policy enforcement; and
- unsent `ISendPendingEmails` older than the email objective.

Operator rules:

- Requeue only an exhausted retry whose failure was conclusively before submission, using `POST /_functions/requeueISendOrder` with `X-ISEND-RECOVERY-SECRET`.
- Do not requeue `invalid-isend-order-payload` against the same immutable snapshot. Correct the authoritative Wix order and use a reviewed replacement or snapshot-remediation procedure first.
- Never automatically requeue an outbox `unknown_outcome`. Reconcile it against iSend using the stable Wix/customer identity.
- For the canonical `isend:<environment>:<custOrderNo>:single-parcel-fulfillment` claim in `processing` or `unknown_outcome`, inspect the authoritative Wix order and its fulfillments. If the one expected fulfillment exists, preserve the claim and mark it completed with operator/time evidence. Remove that single order-level claim only after authoritative confirmation that no fulfillment exists.
- Before the first retention run, export `ISendOrderOutboxClaims`. In a controlled staging backend invocation, seed one old released nonlatest generation plus a latest generation for the same key, an unexpired claim, an unreleased claim, and a recently released claim. Retain a `dryRun` summary, run the real cleanup, and prove only the old nonlatest generation was removed. Confirm the `ISendMaintenanceState` cursor advances across a truncated page and clears after a complete cycle.
- Never delete evidence merely to clear an alert.

Exercise these rules in staging and retain proof that completed claims replay safely while ambiguous claims stop and alert.

## 9. Accept Capacity

The outbox runs hourly, handles at most five orders per run, and operates for twelve hours per MYT service day. Its nominal maximum is 60 submitted orders per service-window day before retries, starting backlog, or slow upstream calls consume capacity. The poller is scheduled hourly but only twelve service-window cycles can call iSend, so its maximum is also 60 mapping queries/day and it currently performs a fresh login per selected mapping. Daily claim retention scans at most 1,000 old released rows and deletes at most 500 safe nonlatest rows. The lifecycle-intent collection is append-only. None of these nominal bounds is capacity acceptance.

Before production, measure staging runtime and agree on all of the following:

- expected average and peak approved-order volume;
- maximum acceptable queue age;
- backlog alert threshold;
- time to drain a peak backlog within the service window;
- eligible claim generations/day, preserved rows scanned/day, unique claim keys/day, total claim rows/day, claim collection occupancy, and retention-cycle duration;
- lifecycle-intent rows/day, current occupancy, Wix collection limit, and storage runway;
- nonzero P95 and maximum runtime for outbox, poller, retention, and operational health;
- iSend request-rate and concurrency limits; and
- aggregate observed peak Wix Data read/write requests per minute across all integration jobs, plus Wix scheduled-job and collection limits.

Copy `capacity-evidence.example.json` to a controlled evidence artifact, replace every placeholder with measured staging evidence, set its attestation fields only after independent review, commit the exact audited source, and run:

```bash
npm run check:capacity -- --evidence <retained-evidence.json> --environment staging
```

The checker rejects a dirty worktree, a non-HEAD revision, stale/unattested evidence, evidence-supplied schedule/batch overrides, zero P95/maximum runtime samples, maximum runtime above the Wix job limit, insufficient provider request budget, unsafe aggregate peak Wix Data read/write rates, retention backlog, and less than the required claim or lifecycle-intent storage runway. Retain the accepted input and generated report against the exact commit SHA. Apply the accepted report's `maintenanceStateConfiguration` fields to deterministic row `ISendMaintenanceState/isend-claim-retention-cursor-v1`, then retain an operational-health result proving its capacity revision equals `ISTORE_ISEND_DEPLOYED_REVISION`. A green outbox result alone does not establish poller, retention, health, or storage capacity.

Production capacity is accepted only when peak volume plus retry headroom remains below measured throughput and the backlog drains within the agreed objective. Otherwise redesign or increase the worker capacity in a separate reviewed change.

## 10. Resolve Partner Contract Decisions

The partner-provided *iStore iSend API Reference, Version 1.9* (2025) confirms
the following interface facts, but it does not by itself approve a production
canary:

- Add Order uses `POST /Json/WebApiOrder/doAddWebApiOrder`; its documented
  success example has `success=true`, `msgList.actualAdd=true`, and
  `returnObject=null`.
- Query Order Status and Tracking Code accepts both `custOrderNo` and
  `documentNo`, describes `documentNo` as the external/platform order number,
  and returns `custOrderNo` in `currentPageData`.
- The Order Status Webhook payload uses `action="order"`, places the status in
  `value`, and carries `custOrderNo` plus `documentNo`.
- The document does not specify an HMAC/signature header, signed delivery ID,
  retry policy, multi-parcel line allocation, global cross-environment
  `custOrderNo` uniqueness, credential rotation, or whether the newly created
  order is immediately queryable by `documentNo`.

The worker therefore performs only a bounded post-create identity recovery:
when Add Order succeeds without `custOrderNo`, it queries by the submitted
platform order number and accepts exactly one row with an exact `documentNo`
match and a nonblank `custOrderNo`. Zero, duplicate, mismatched, delayed, or
failed query results remain `unknown_outcome` and must not be resubmitted.
Webhook handling recognizes the documented `action`/`value` shape only after
the existing HMAC check succeeds; do not register an unsigned webhook.

Obtain written iSend confirmation for each item:

1. A successful create-order response contains `custOrderNo`, that value is the correct query key for `/Json/WhseOrder/doQueryOrderPage`, and a successful query reports authoritative `returnObject.totalRecord=1` plus exactly one page row carrying the same `custOrderNo` when the order exists.
2. Tracking and status webhooks carry that same customer-order identity, not an unrelated internal `orderNo` or `orderId`.
3. For multiple parcels, every tracking number is allocated to explicit Wix eCommerce line-item IDs and quantities. Until implemented and tested, multiple unique tracking numbers remain a production blocker and must continue to fail closed.
4. Confirm signed webhooks as the primary tracking/status path and document signed-body delivery IDs, event names, retry timing, and retryable status handling. The staggered hourly `runISendPollerJob` is the bounded safety net; the protected `POST /_functions/runISendPoller` remains an operator diagnostic with the same fixed five-mapping, one-page, reconciliation-only boundary, not the production scheduler.
5. Confirm the inventory payload and endpoint contract before enabling inventory polling.
6. Define an authoritative lookup plus idempotent-create or quiescence guarantee before automating recovery of ambiguous iSend submissions.
7. Confirm whether `custOrderNo` is globally unique across staging and production. Until confirmed, keep the global unique mapping index and never reuse an iSend customer-order number across environments; relaxing it requires an authenticated environment discriminator (or separate endpoint and secret) in every webhook.
8. Confirm the authoritative event ordering field or sequence for status webhooks. Until it is implemented, retain the fail-closed monotonic policy: nonterminal progress cannot regress, `CANCELLED`/`RETURNED` are final, and only `RETURNED` may follow `DELIVERED`.

Record the decisions and sample redacted payloads with the production authorization.

## 11. Production Canary

Do not start the canary until secrets, data, publication, strict staging probe, single-parcel staging evidence, reconciliation drills, capacity acceptance, alerts, and partner decisions are all complete.

1. Schedule the canary inside the iSend service window with Wix, iSend, and operations owners present.
2. Freeze or tightly control normal order intake so only one identified single-parcel canary can enter the new path.
3. Stop new staging intake and quiesce staging webhook delivery. Prove there are no staging outbox rows in `pending`, `processing`, or retryable `retry`; resolve every staging attention state; and require every staging mapping to have `reconciliationActive=false`. Require explicit, proven environment bindings on every environment-sensitive outbox/mapping row and every migrated webhook audit, inventory row, pending email, and raw-webhook claim. Append-only lease claims are not environment business records and are governed by their claim key/generation retention rule instead.
4. Verify the production root is exactly `https://webapi.istoreisend-wms.com/IsisWMS-War` (or its host-only form), verify the credentials and recorded single-parcel approval gate, then change only the Wix environment selector to the production environment through Secrets Manager.
5. Observe all scheduled jobs once, require zero missing- or other-environment conflicts, and require a green claim-retention summary before accepting a production order.
6. Submit one controlled order and observe every evidence point from the staging checklist through fulfillment and email.
7. Wait through a webhook replay or deliberate poll reconciliation and confirm idempotency.
8. Inspect all attention states and alerts before reopening order intake.
9. Expand volume gradually only after the named approver signs the canary record.

If the canary becomes ambiguous, stop new order intake and reconcile the existing outbox, mapping, and fulfillment records before changing environments or retrying. Never treat switching back to staging as a safe rollback for already accepted production orders, and never blindly resubmit an `unknown_outcome`.
