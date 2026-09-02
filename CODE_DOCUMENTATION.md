# Code Documentation Guide

This document explains the main code files in the repository and describes what the exported functions do. It is intended to help a new developer understand the structure and behavior of the code.

## Overview

The project has three main areas:

- `scripts/` - command-line utilities for testing and local development.
- `src/backend/` - Wix backend code for handling orders, webhooks, polls, and iSend integration.
- `src/pages/` and `src/public/` - page code and public utility code used by site pages.

Most of the custom logic is in `src/backend/`.

---

## scripts/check-isend.js

This file is a small Node.js CLI tool for validating iSend login credentials.

Functions:

- `parseArgs()`
  - Parses simple command-line arguments into an object.
  - Supports flags like `--user`, `--password`, `--env`, `--staging-url`, and `--production-url`.

- `postJson(urlString, body, timeout)`
  - Sends an HTTPS POST request with a JSON body only after endpoint validation.
  - Rejects redirects, URL credentials/query/fragment, oversized responses, and any response that does not finish before the absolute deadline.
  - Parses the response and returns status and parsed JSON.

- `checkLogin(baseUrl, user, pass, timeout, environment)`
  - Validates the base URL against the exact staging or production host/port/path allowlist, builds the iSend login URL, and calls `postJson`.
  - Returns success only when iSend reports business success and provides either a complete session ID/password pair or a nonempty `JSESSIONID` cookie.

- `main()`
  - Entry point for the CLI.
  - Validates required parameters.
  - Runs login checks for staging and/or production.
  - Exits with code `0` when all checks pass, otherwise errors.

---

## scripts/mock-isend-server.js

A simple local mock server that simulates iSend login behavior for isolated tests and development.

- Creates an HTTP server that responds to `POST /IsisWMS-War/Json/Public/login` with a fake successful login response.
- It is not accepted by the live credential-checking CLI, which intentionally requires HTTPS and a documented partner endpoint.

---

## src/backend/isendConfig.js

This module reads Wix secrets and builds a configuration object for iSend calls.

Functions:

- `readRequiredSecret(name)`
  - Reads a Wix Backend secret.
  - Throws an error if the secret is missing.

- `readOptionalSecret(name)`
  - Reads a Wix Backend secret and returns `undefined` when not set.

- `getISendConfig(options = {})`
  - Reads the required iSend configuration values from secrets.
  - Supports `environment` or `useSandbox` to choose staging vs production URL.
  - Uses the Wix secret `ISTORE_ISEND_ENV` when no option is passed.
  - Validates every configured endpoint before returning credentials.
  - Returns an object with `storageClientNo`, `userNo`, `userPassword`, `orderOrigin`, `userId`, `orderSource`, `baseUrl`, `environment`, and the explicit `Asia/Kuala_Lumpur` order timezone.

- `validateISendBaseUrl(value, environment)`
  - Requires an absolute HTTPS URL with no embedded credentials, query, or fragment.
  - Permits only the documented environment-specific host/port and either `/` or `/IsisWMS-War`.
  - Returns a canonical URL or throws `invalid-isend-url` before any credentials or order data are sent.

- `getConfiguredISendEnvironment(options = {})`
  - Reads and normalizes only `ISTORE_ISEND_ENV` for durable queue and mapping boundaries.
  - Accepts an explicit internal environment for trusted workers/tests and rejects missing or invalid selectors.

This module is the central source of truth for iSend credentials and endpoints.

---

## src/backend/isendIdempotency.js

This module prevents duplicate processing of repeated events.

Functions:

- `getProcessed(idempotencyKey)`
  - Strongly reads and returns the complete `ISendProcessedEvents` record for a key.
  - Callers that protect external effects must inspect `meta.status`, not treat every existing row as completed.

- `hasProcessed(idempotencyKey)`
  - Checks the `ISendProcessedEvents` collection for the given key.
  - Returns `true` if the key was already recorded.

- `markProcessed(idempotencyKey, meta = {})`
  - Inserts a new record into `ISendProcessedEvents`.
  - Stores optional metadata along with the key.

- `claimProcessed(idempotencyKey, meta = {})`
  - Atomically inserts a deterministic `processing` claim before an external side effect.
  - Returns the existing record after a duplicate/raced insert so the caller can distinguish `completed` from an ambiguous state.

- `updateProcessed(idempotencyKey, meta = {})`
  - Updates metadata for an existing idempotency key.

- `releaseProcessed(idempotencyKey)`
  - Low-level administrative helper that removes a claim.
  - Fulfillment processing never calls it automatically after a Wix request because the remote fulfillment may have succeeded even when the response was lost.

This pattern is used by webhook processing and fulfillment creation to avoid duplicate work. For fulfillment claims, only `meta.status: completed` is safe to acknowledge as a duplicate. `processing`, `unknown_outcome`, and legacy/missing states require operator reconciliation.

---

## src/backend/isendMappings.js

This module stores and reads mappings between Wix order IDs and iSend order numbers.

Functions:

- `saveMapping(wixOrderId, iSendOrderNo, meta = {}, environment)`
  - Saves a new mapping record into `ISendOrderMap`.
  - Persists an immutable `staging` or `production` binding and rejects an existing mapping from another environment.
  - `meta` can store raw response data or additional context.

- `getByISendOrderNo(iSendOrderNo, environment)`
  - Strongly reads at most two mappings by iSend order number.
  - Throws deterministic nonretryable `ambiguous-isend-mapping` when more than one row exists in the requested scope instead of silently selecting one.

- `getByWixOrderId(wixOrderId, environment)`
  - Strongly reads at most two mappings by Wix order ID.
  - Applies the same deterministic ambiguity guard to the second identity axis.

- `findMappings(limit = 100, skip = 0, environment)`
  - Reads a stably ordered, current-environment batch for the protected manual poller.

- `findMappingsForReconciliation(environment, limit = 5)`
  - Reads only current-environment active mappings, oldest reconciliation attempt first, for the scheduled safety net.

- `findUnclassifiedMappingsForReconciliation(environment, limit = 5)`
  - Selects a bounded, already environment-bound pre-upgrade batch whose reconciliation state still needs initialization.

- `findReconciliationEnvironmentConflicts(environment)`
  - Finds active other-environment or unassigned legacy mappings so the scheduled job fails without querying iSend.

- `updateMappingReconciliation(iSendOrderNo, fields, environment)`
  - Updates reconciliation scheduling fields under the distributed mapping-mutation lease.

---

## src/backend/isendMappingMutationLock.js

This module serializes full-item `ISendOrderMap` writes across Wix workers. It stores append-only, deterministic generations in `ISendOrderOutboxClaims` under `isend-mapping:<iSendOrderNo>`. A 30-second lease, same-generation insert race, and token-fenced release prevent concurrent webhook, status, delivery, and poller updates from replacing one another.

Mapping lookup is essential when webhook events arrive from iSend and need to be connected to Wix orders.

---

## src/backend/isendClaimRetention.js

This module performs bounded cleanup of append-only lease generations.

- `cleanupISendClaimGenerations(options)`
  - Defaults to a 7-day safety interval, a 1,000-row scan, and at most 500 deletes per run.
  - Selects only explicitly released rows outside the retention interval, verifies latest generations in bounded grouped-aggregation batches, and bulk-deletes only rows for which a strictly newer generation was positively observed.
  - Preserves latest, unexpired, unreleased, recent, malformed, and legacy generationless rows.
  - Persists an `_id` keyset cursor in `ISendMaintenanceState` so preserved latest rows cannot starve later bounded pages.
  - Supports write-free `dryRun` summaries and fails closed on unverified groups, stale unreleased rows, partial bulk results, throttling, runtime limits, or incomplete cycles.

- `runISendClaimRetentionJob(options)`
  - Scheduled daily at 18:15 UTC (02:15 MYT).
  - Logs the bounded summary and throws a durable retention attention error whenever any invalid, stale, partial, throttled, runtime-limited, deferred, or incomplete state remains.

- `calculateISendClaimRetentionCapacity(options)`
  - Pure sizing model for daily eligible-row deletion and total scan demand, including preserved rows.
  - The default policy deletes 500 and scans 1,000 rows/day; acceptance comes from exact-SHA measured evidence, not a fixed estimated creation rate.

---

## src/backend/isendService.js

This module contains the API integration logic for iSend.

Key responsibilities:

- Logging in to iSend.
- Building request payloads from Wix orders.
- Sending orders to iSend.
- Querying tracking and status information.

Functions:

- `trimTrailingSlash(value)`
  - Helper to normalize endpoint URLs.

- `getBaseUrl(config)`
  - Revalidates and returns the environment-bound iSend base URL.

- `getMytDate(now)`
  - Converts a date to Malaysia Time (MYT), since iSend operates in that timezone.

- `isWithinISendServiceWindow(now)`
  - Checks whether a date falls inside the configured iSend service window.

- `getServiceWindowStatus(now)`
  - Returns a structured object describing the service window state.

- `runBoundedRequest(url, operation, timeoutMs)`
  - Runs the complete network operation under one absolute deadline.
  - Aborts the underlying fetch when the deadline expires, including while the response body is being consumed.

- `postJson(url, body, headers = {})`
  - Sends a JSON POST request, manually rejects all redirects, reads the response within the deadline, and validates the result.

- `formatISendDate(value, timeZone)`
  - Formats order timestamps deterministically as `D/M/YYYY HH:mm:ss`.
  - Defaults to the partner timezone `Asia/Kuala_Lumpur` rather than the runtime machine timezone.

- `loginToISend()`
  - Logs in to iSend and returns the session credentials.

- `testISendLogin(options = {})`
  - Tests login and returns whether it is valid.

- `mapOrderToISend(order, config)`
  - Normalizes numeric strings and SKU whitespace, then rejects missing identity, empty items, blank SKUs, invalid quantities/prices/totals, and incomplete delivery contact/address data.
  - Fully zero-total orders fail closed until the partner contract explicitly permits them; zero-priced promotional lines remain valid inside a positive-total order.

- `sendOrderToISend(order)`
  - Converts a Wix order into iSend format and sends it.
  - Skips the call if the current time is outside the iSend service window.
  - Classifies validation failures as the `payload` phase before any login or submit request.

- `getTrackingInfo(customerOrderNo)`
  - Queries iSend for tracking and order details for a given order number.

This module is the core translator between Wix order data and iSend API payloads.

---

## src/backend/isendStatusMapping.js

This module normalizes status strings from iSend and updates mapping records.

Functions:

- `mapISendStatus(iSendStatus)`
  - Converts raw iSend status text into canonical labels such as `SHIPPED`, `DELIVERED`, `CANCELLED`, `PICKED`, `PROCESSING`, and `RETURNED`.

- `updateMappingStatus(iSendOrderNo, iSendStatus, options = {})`
  - Finds the mapping record by iSend order number.
  - Requires the current environment binding and performs the full-item update under the distributed mapping-mutation lease.
  - Applies monotonic status transitions: delayed nonterminal events cannot regress progress, `CANCELLED`/`RETURNED` are final, and only `RETURNED` may follow `DELIVERED`.
  - Reactivates accepted non-final progress for reconciliation while preserving the poller's terminal deactivation boundary.
  - Direct callers may run the idempotent `handleDelivered` workflow; webhook and poller callers defer it until the one tracking fulfillment is confirmed, so a status-only `DELIVERED` event cannot send email early.
  - Persistence and any requested delivery-side-effect failures propagate rather than being acknowledged.

This module is used whenever order status updates come from iSend via webhook or polling.

---

## src/backend/isendWebhookHandler.js

This module receives and processes incoming iSend webhook events.

Key behavior:

1. Reject a declared or observed body larger than 1 MiB with HTTP 413, then verify the exact raw body bytes using the signature secret `ISTORE_ISEND_WEBHOOK_SECRET`.
2. Parse only the authenticated body and determine the event type from signed `eventType`/`type`; unsigned event headers do not control routing.
3. Scope signed-body `deliveryId`/`eventId` to the configured iSend environment, falling back to the signed body hash; unsigned delivery-ID headers do not control dedupe.
4. Handle tracking events by creating Wix fulfillments, while refusing delayed tracking after a final status.
5. Handle inventory events through a deterministic environment/SKU row identity.
6. Handle order status events by updating mapping status.
7. Before contract validation or business effects, persist each authenticated, parsed, not-yet-processed delivery with a deterministic environment-scoped ID in `ISendWebhookEvents`; retries reuse that raw-audit identity.

Functions:

- `getHeader(request, name)`
  - Reads a header value from HTTP request headers in a case-insensitive way.

- `safeTimingEqual(aHex, bHex)`
  - Securely compares signatures to prevent timing attacks.

- `extractTrackingNumbers(obj)`
  - Walks a payload object and extracts strings that look like tracking numbers.

- `handleWebhook(request)`
  - Main entrypoint for webhook processing.
  - Routes the request to the appropriate handling logic.
  - Returns explicit permanent fulfillment-contract failures as nonretryable 4xx responses while preserving infrastructure/unknown failures as retryable server errors.

This module is the main webhook processor for the integration.

---

## src/backend/orderFulfillment.js

This file creates order fulfillments inside Wix.

Functions:

- `createFulfillment(orderId, options = {})`
  - Builds the fulfillment object for Wix.
  - Supports eCommerce line-item IDs, `trackingNumber`, `shippingProvider`, `trackingLink`, and `idempotencyKey`.
  - Uses the elevated current Wix eCommerce `orderFulfillments.createFulfillment` API.
  - Claims the supplied idempotency key before calling Wix and records `completed` only after the fulfillment response is durably saved.
  - A `completed` claim is a safe skip only when its stored order, line-item, and tracking fingerprint matches the current request. Reused/mismatched keys, existing `processing`/`unknown_outcome` claims, and any ambiguous Wix response throw `fulfillment-reconciliation-required`; they are never deleted for an automatic retry.

- `getSingleParcelFulfillmentKey(iSendOrderNo, environment)`
  - Returns the one environment-scoped order-level key `isend:<environment>:<custOrderNo>:single-parcel-fulfillment`.

- `createISendSingleParcelFulfillment(iSendOrderNo, orderId, options = {})`
  - Serializes the mapping/status check and fulfillment effect under a fenced mapping lease.
  - Refuses a final or unsupported stored status and calls `createFulfillment` with the order-level key.
  - Requires the owner-approved single-parcel contract, exactly one consistent parcel/tracking record, and no allocation/split evidence.
  - Fetches the authoritative Wix order inside the lease, rejects cancellation/refund or any existing fulfilled quantity, and uses every current line-item ID/quantity; a supplied line-item assertion must match that full set exactly.
  - Makes a later different tracking number a completed-fingerprint mismatch, enforcing the current one-parcel prohibition across separate webhook and poller deliveries.

The single-parcel coordinator is used by webhook handling, polling, and the separately protected fulfillment HTTP boundary. The lower-level function is an internal primitive and must not be exposed with caller-selected keys.

---

## src/backend/orderStateTransitions.js

This module handles the transition when an iSend order becomes delivered.

Functions:

- `handleDelivered(iSendOrderNo, options = {})`
  - Finds the mapping for the iSend order number in the current environment.
  - Updates the mapping metadata with delivery timestamps under the distributed mapping-mutation lease.
  - Records a `DELIVERED` event in `ISendWebhookEvents` using a deterministic ID.
  - Uses the elevated current Wix eCommerce Orders API to find the buyer email.
  - Creates one deterministic pending email record in `ISendPendingEmails` so an email can be sent later.
  - Throws retryable `isend-delivery-email-missing` before completing delivery effects when neither buyer nor billing email resolves, leaving the webhook unprocessed and poller mapping active.
  - Treats duplicate deterministic IDs as successful replay and propagates every other write/read failure for retry.

This helper is triggered automatically when status sync detects a delivery event.

---

## src/backend/isendPoller.js

This module polls iSend for updates on mapped orders.

Functions:

- `extractTrackingNumbers(obj)`
  - Scans only recognized tracking, parcel, waybill, and AWB fields for plausible values.

- `runPoller(options = {})`
  - Loads mappings from `ISendOrderMap`.
  - For each mapping, calls `getTrackingInfo`.
  - Updates stored status via `updateMappingStatus`.
  - Reads the current Wix eCommerce order and creates fulfillment records if new tracking numbers are found.
  - Returns `success: false` with per-stage details when a selected sync action fails.
  - Optionally supports inventory sync in the future.

- `runISendPollerJob(options = {})`
  - Runs a five-mapping active-only reconciliation batch as an hourly webhook safety net.
  - Leaves outside-window skips at the front of the queue, retires terminal mappings only after required side effects, and throws on partial failure so Wix monitoring can alert.

Signed webhooks are the primary mechanism. This bounded poller is the fallback/background safety net for keeping Wix and iSend in sync.

---

## src/backend/http-functions.js

This file exposes Wix HTTP endpoints.

Functions:

- `get_testISendLoginFromWix(request)`
  - HTTP GET endpoint used to validate iSend login from the site.
  - Requires `X-ISEND-POLLER-SECRET`, runs only when the site's authoritative environment is staging, ignores query environment/force overrides, and redacts upstream/session values.

- `post_isendWebhook(request)`
  - HTTP POST endpoint for receiving iSend webhooks.
  - Propagates controlled 413 responses for bodies above the 1 MiB request limit.

- `post_runISendPoller(request)`
  - HTTP POST endpoint to trigger the poller.
  - Protected by header `X-ISEND-POLLER-SECRET` and the Wix secret `ISEND_POLLER_TRIGGER_SECRET`.
  - Uses the site's configured `ISTORE_ISEND_ENV`; request bodies cannot redirect the site to another environment or change the fixed tracking/status, five-mapping, one-page, reconciliation-only safety bounds.
  - Returns a failing HTTP status with only bounded counts and failure-stage codes when the poller reports any selected sync failure; raw upstream errors and order identifiers remain server-side.

- `post_requeueISendOrder(request)`
  - Re-enables only a retry-exhausted record whose failure was conclusively before submit.
  - Requires the operator-only `X-ISEND-RECOVERY-SECRET`; automated poller credentials cannot invoke it.
  - Rejects `unknown_outcome` because a point-in-time confirmation cannot prove a timed-out submit will not complete later.

- `post_createFulfillmentFromWix(request)`
  - HTTP POST endpoint to create the one permitted Wix fulfillment from an external request.
  - Protected by header `X-ISEND-FULFILLMENT-SECRET` and the Wix secret `ISEND_FULFILLMENT_TRIGGER_SECRET`.
  - Requires a mapped `iSendOrderNo`, `orderId`, and one tracking number, selects the site environment internally, and calls `createISendSingleParcelFulfillment`.
  - Cannot authorize a partial fulfillment: the coordinator reads all authoritative Wix line items, and any supplied line-item assertion must match them exactly.
  - Rejects a caller-selected `idempotencyKey`; if supplied, it must equal the canonical order-level single-parcel key.

This file connects backend logic to external HTTP calls.

---

## src/backend/events.js

This is the Wix event handler file.

- `wixStores_onNewOrder(event)`
  - Legacy Wix Stores event boundary.
  - Durably enqueues the order before any iSend request.

- `wixEcom_onOrderApproved(event)`
  - Modern Wix eCommerce replacement boundary (`event.data.order`).
  - Uses the same deterministic queue key as the legacy event, so duplicate deliveries converge.

- `wixEcom_onOrderUpdated(event)`, `wixEcom_onOrderPaymentStatusUpdated(event)`, and `wixEcom_onOrderTransactionsUpdated(event)`
  - Persist a durable lifecycle intent before contending for the outbox claim.
  - Refresh a pre-submit snapshot or flag post-submit/refund ambiguity for operator attention.

- `wixEcom_onOrderCanceled(event)` and `wixStores_onOrderCanceled(event)`
  - Persist cancellation intent before the claim. Unsubmitted work becomes `canceled`; submitted or ambiguous work remains durable attention because no upstream cancel contract is assumed.

---

## src/backend/isendOrderOutbox.js

This module owns durable Wix-to-iSend order submission.

- `enqueueISendOrderEvent(event)` stores a normalized order snapshot with a deterministic Wix item ID and immutable current-environment binding.
- `refreshISendOrderEvent(event)` and `cancelISendOrderEvent(event)` store append-only records in `ISendOrderLifecycleIntents` before claim acquisition so a busy worker cannot drop the event.
- `runISendOrderOutbox(options)` claims and processes a bounded batch during the MYT service window and scans durable attention states on every run.
- `runISendOrderOutboxJob(options)` keeps scheduled monitoring failed while any unknown, exhausted-retry, stale-processing, lifecycle-attention, environment, or current worker failure remains.
- `requeueISendOrder(orderKey, options)` re-enables only an exhausted, conclusively pre-submit retry.

Unique deterministic item IDs, strongly consistent post-claim state revalidation, and monotonic lease generations prevent concurrent workers from submitting a stale row. The worker rereads the authoritative Wix order, lifecycle intents immediately before submit, and lifecycle intents again after the provider response and mapping persistence. Pre-submit cancellation/full refund stops submission; partial-refund, already-fulfilled, changed-during-submit, and post-submit cancellation states fail closed with durable attention. Claim releases expire only their own generation, so a stale worker cannot remove a newer lease. Missing or current-selector-mismatched environment bindings remain visible attention states and never reach iSend. Transient confirmed pre-submit failures retry with backoff; deterministic payload validation exhausts immediately. Ambiguous submit outcomes stop permanently in `unknown_outcome` until an authoritative provider-approved recovery exists.

---

## Scheduled status reconciliation

`src/backend/isendPoller.js` exports `runISendPollerJob`, a five-mapping hourly safety net for missed signed webhooks. Current-environment active mappings are selected through `ISendOrderMap.reconciliationActive` in oldest-`lastReconciledAt` order; active other-environment and unassigned legacy mappings fail visibly without an upstream call. Every business-success query must report authoritative `returnObject.totalRecord=1`, contain exactly one page row, and have that row's exact `custOrderNo` match the selected mapping before status or tracking fields are trusted. Outside-window skips do not rotate the queue. `CANCELLED` and `RETURNED` stop after their status write succeeds. `DELIVERED` stops only after the delivery workflow and the single-tracking fulfillment both complete safely. A delivered response without tracking, multiple tracking values, ambiguous fulfillment claims, partner failures, and reconciliation-state failures keep the mapping active and fail the scheduled job visibly. A nonterminal response without tracking remains active for a later reconciliation attempt without failing solely for the absent tracking value.

The manual protected poll endpoint retains bounded stable pagination for operator diagnostics. Scheduled and manual polling keep the Wix-configured iSend environment authoritative.

---

## src/backend/isendOperationalHealth.js

`runISendOperationalHealthJob` runs hourly at minute 45 and throws whenever durable state is unhealthy. Its bounded, environment-scoped snapshot covers outbox backlog/age, unknown outcomes, retry exhaustion, stale processing, lifecycle attention, active mappings, stale unsent email, fulfillment claims in `processing`/`unknown_outcome`/invalid states, claim-retention cycle/runtime/verification failures, claim and lifecycle-intent occupancy/runway, capacity evidence whose revision exactly matches backend secret `ISTORE_ISEND_DEPLOYED_REVISION`, and owner-approved external retention/scrubbing enforcement for raw webhook payloads, sent emails, resolved terminal outbox snapshots, and completed fulfillment-claim results. A fulfillment-key scan over 1,000 rows fails red instead of silently sampling.

`scripts/check-isend-capacity.js` binds schedule and batch assumptions to `jobs.config` and source constants. It rejects plan overrides, template/unattested/stale evidence, zero P95/maximum runtime samples, maximum runtime beyond the Wix job limit, a dirty worktree, a non-HEAD 40-character SHA, mismatched environment, insufficient provider request budget, unsafe observed aggregate Wix Data peak rates, retention backlog, or insufficient claim/lifecycle-intent runway. Its accepted `maintenanceStateConfiguration` output must be applied to the deterministic maintenance row before operational health can accept the same deployed revision.

---

## src/public/new-file.js

A sample public utility module.

- `add(param1, param2)`
  - Simple function that returns the sum of two values.

The comments in this file also show how to import it from page code.

---

## src/pages/*.js

Most page files contain basic Wix page code boilerplate:

- `$w.onReady(function () { ... })`

These files are page-specific scripts that run when the page loads.
They currently do not contain custom business logic beyond the default scaffolding.

---

## How the main integration flow works

1. A new Wix order is created.
2. Wix triggers the legacy `wixStores_onNewOrder` or modern `wixEcom_onOrderApproved` handler in `src/backend/events.js`; update, refund/payment, transaction, and cancellation events use the corresponding lifecycle handlers.
3. Approval persists the full order in `ISendOrderOutbox`; every later lifecycle handler persists an append-only `ISendOrderLifecycleIntents` record before claim contention. Event handlers do not call iSend.
4. The hourly scheduled worker claims a bounded batch, rereads the authoritative Wix order/lifecycle state, and calls `sendOrderToISend` only inside 09:00-23:00 MYT.
5. A business-success response with queryable `custOrderNo` is saved in `ISendOrderMap` before the outbox row becomes `sent`; `orderNo` and `orderId` alone remain quarantined until the partner confirms their semantics.
6. When iSend sends a webhook, `post_isendWebhook` authenticates the exact raw bytes and calls `handleWebhook`.
7. `handleWebhook` checks idempotency and routes the payload:
   - Tracking events create Wix fulfillments.
   - Status events update order mapping status without regressing a later/final state.
   - Inventory events update one deterministic environment/SKU row in `ISendInventory`.
8. The staggered hourly poller in `src/backend/isendPoller.js` reconciles a bounded set of active mappings as a webhook safety net and fails visibly on partial work.
9. The daily retention job advances a persisted keyset cursor and removes only positively verified released nonlatest lease generations older than the configured interval.
10. Hourly operational health fails visibly on unresolved lifecycle, fulfillment, retention, storage, capacity, or sensitive-data-policy state.
11. When a mapped order becomes delivered, `handleDelivered` records the event and creates a pending email.

---

## Notes for new programmers

- The backend code uses Wix collections to store state:
  - `ISendOrderMap`
  - `ISendOrderOutbox`
  - `ISendOrderLifecycleIntents`
  - `ISendOrderOutboxClaims`
  - `ISendMaintenanceState`
  - `ISendProcessedEvents`
  - `ISendWebhookEvents`
  - `ISendInventory`
  - `ISendPendingEmails`

- Secrets are read from Wix Backend Secrets and are not stored in code.
- The code uses `async`/`await` for asynchronous operations.
- Many helpers normalize data from Wix order objects because Wix order shape can vary.
- Idempotency is important when handling webhooks or tracking updates so the same event does not create duplicate fulfillments.

---

## Recommended reading order

1. Start with `src/backend/isendConfig.js` to understand secrets and config.
2. Read `src/backend/isendService.js` to see how Wix orders become iSend requests.
3. Read `src/backend/events.js` to follow the incoming order event flow.
4. Read `src/backend/isendOrderOutbox.js` to understand durable submission, retries, and ambiguous outcomes.
5. Read `src/backend/isendWebhookHandler.js` to understand webhook processing.
6. Read `src/backend/isendPoller.js` to understand the fallback sync mechanism.
7. Read `src/backend/orderFulfillment.js` and `src/backend/orderStateTransitions.js` for fulfillment and delivery behavior.
8. Read `src/backend/isendMappings.js` and `src/backend/isendStatusMapping.js` for persistence and status normalization.
