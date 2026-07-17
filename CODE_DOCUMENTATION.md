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
  - Sends an HTTP POST request with JSON body.
  - Parses the response and returns status and parsed JSON.

- `checkLogin(baseUrl, user, pass, timeout)`
  - Builds the iSend login URL and calls `postJson`.
  - Returns success only when iSend reports business success and provides either a complete session ID/password pair or a nonempty `JSESSIONID` cookie.

- `main()`
  - Entry point for the CLI.
  - Validates required parameters.
  - Runs login checks for staging and/or production.
  - Exits with code `0` when all checks pass, otherwise errors.

---

## scripts/mock-isend-server.js

A simple local mock server that simulates iSend login behavior.

- Creates an HTTP server that responds to `POST /IsisWMS-War/Json/Public/login` with a fake successful login response.
- Useful for local testing of login flows without connecting to the real iSend API.

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
  - Returns an object with `storageClientNo`, `userNo`, `userPassword`, `orderOrigin`, `userId`, `orderSource`, `baseUrl`, and `environment`.

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

- `saveMapping(wixOrderId, iSendOrderNo, meta = {})`
  - Saves a new mapping record into `ISendOrderMap`.
  - `meta` can store raw response data or additional context.

- `getByISendOrderNo(iSendOrderNo)`
  - Finds a mapping by iSend order number.

- `getByWixOrderId(wixOrderId)`
  - Finds a mapping by Wix order ID.

- `findMappings(limit = 100, skip = 0)`
  - Reads a batch of mapping records.

Mapping lookup is essential when webhook events arrive from iSend and need to be connected to Wix orders.

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
  - Returns the configured iSend base URL.

- `getMytDate(now)`
  - Converts a date to Malaysia Time (MYT), since iSend operates in that timezone.

- `isWithinISendServiceWindow(now)`
  - Checks whether a date falls inside the configured iSend service window.

- `getServiceWindowStatus(now)`
  - Returns a structured object describing the service window state.

- `withTimeout(promise, timeoutMs, label)`
  - Adds a timeout to a promise.

- `postJson(url, body, headers = {})`
  - Sends a JSON POST request and validates the response.

- `loginToISend()`
  - Logs in to iSend and returns the session credentials.

- `testISendLogin(options = {})`
  - Tests login and returns whether it is valid.

- `sendOrderToISend(order)`
  - Converts a Wix order into iSend format and sends it.
  - Skips the call if the current time is outside the iSend service window.

- `getTrackingInfo(customerOrderNo)`
  - Queries iSend for tracking and order details for a given order number.

This module is the core translator between Wix order data and iSend API payloads.

---

## src/backend/isendStatusMapping.js

This module normalizes status strings from iSend and updates mapping records.

Functions:

- `mapISendStatus(iSendStatus)`
  - Converts raw iSend status text into canonical labels such as `SHIPPED`, `DELIVERED`, `CANCELLED`, `PICKED`, `PROCESSING`, and `RETURNED`.

- `updateMappingStatus(iSendOrderNo, iSendStatus)`
  - Finds the mapping record by iSend order number.
  - Updates the stored status in the mapping metadata.
  - Every `DELIVERED` report retries the idempotent `handleDelivered` workflow so a prior partial failure is not stranded.
  - Persistence and delivery-side-effect failures propagate to the webhook/poller rather than being acknowledged.

This module is used whenever order status updates come from iSend via webhook or polling.

---

## src/backend/isendWebhookHandler.js

This module receives and processes incoming iSend webhook events.

Key behavior:

1. Verify the webhook signature using the secret `ISTORE_ISEND_WEBHOOK_SECRET`.
2. Parse the incoming payload and determine the event type.
3. Use idempotency checks so repeated deliveries do not process twice.
4. Handle tracking events by creating Wix fulfillments.
5. Handle inventory events by storing latest SKU quantities.
6. Handle order status events by updating mapping status.
7. Persist raw webhook events to `ISendWebhookEvents` for auditing.

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

This module is the main webhook processor for the integration.

---

## src/backend/orderFulfillment.js

This file creates order fulfillments inside Wix.

Functions:

- `createFulfillment(orderId, options = {})`
  - Builds the fulfillment object for Wix.
  - Supports eCommerce line-item IDs, `trackingNumber`, `shippingProvider`, `trackingLink`, and `idempotencyKey`.
  - Uses the elevated current Wix eCommerce `orderFulfillments.createFulfillment` API.
  - Claims the canonical tracking key before calling Wix and records `completed` only after the fulfillment response is durably saved.
  - A `completed` claim is a safe skip only when its stored order, line-item, and tracking fingerprint matches the current request. Reused/mismatched keys, existing `processing`/`unknown_outcome` claims, and any ambiguous Wix response throw `fulfillment-reconciliation-required`; they are never deleted for an automatic retry.

This is the function used by both webhook handling and polling.

---

## src/backend/orderStateTransitions.js

This module handles the transition when an iSend order becomes delivered.

Functions:

- `handleDelivered(iSendOrderNo, options = {})`
  - Finds the mapping for the iSend order number.
  - Updates the mapping metadata with delivery timestamps.
  - Records a `DELIVERED` event in `ISendWebhookEvents` using a deterministic ID.
  - Uses the elevated current Wix eCommerce Orders API to find the buyer email.
  - Creates one deterministic pending email record in `ISendPendingEmails` so an email can be sent later.
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

This is the fallback/background mechanism for keeping Wix and iSend in sync.

---

## src/backend/http-functions.js

This file exposes Wix HTTP endpoints.

Functions:

- `get_testISendLoginFromWix(request)`
  - HTTP GET endpoint used to validate iSend login from the site.
  - Requires `X-ISEND-POLLER-SECRET`, always selects staging, and redacts upstream/session values.

- `post_isendWebhook(request)`
  - HTTP POST endpoint for receiving iSend webhooks.

- `post_runISendPoller(request)`
  - HTTP POST endpoint to trigger the poller.
  - Protected by header `X-ISEND-POLLER-SECRET` and the Wix secret `ISEND_POLLER_TRIGGER_SECRET`.
  - Uses the site's configured `ISTORE_ISEND_ENV`; request bodies cannot redirect the site to another environment.
  - Returns a failing HTTP status when the poller reports any selected sync failure.

- `post_requeueISendOrder(request)`
  - Re-enables only a retry-exhausted record whose failure was conclusively before submit.
  - Requires the operator-only `X-ISEND-RECOVERY-SECRET`; automated poller credentials cannot invoke it.
  - Rejects `unknown_outcome` because a point-in-time confirmation cannot prove a timed-out submit will not complete later.

- `post_createFulfillmentFromWix(request)`
  - HTTP POST endpoint to create a Wix fulfillment from an external request.
  - Protected by header `X-ISEND-FULFILLMENT-SECRET` and the Wix secret `ISEND_FULFILLMENT_TRIGGER_SECRET`.
  - Requires a stable nonempty `idempotencyKey` so transport retries cannot bypass the fulfillment state machine.

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

---

## src/backend/isendOrderOutbox.js

This module owns durable Wix-to-iSend order submission.

- `enqueueISendOrderEvent(event)` stores a normalized order snapshot with a deterministic Wix item ID.
- `runISendOrderOutbox(options)` claims and processes a bounded batch during the MYT service window and scans durable attention states on every run.
- `runISendOrderOutboxJob(options)` keeps scheduled monitoring failed while any unknown, exhausted-retry, stale-processing, or current worker failure remains.
- `requeueISendOrder(orderKey, options)` re-enables only an exhausted, conclusively pre-submit retry.

Unique deterministic item IDs, strongly consistent post-claim state revalidation, and monotonic lease generations prevent concurrent workers from submitting a stale row. Claim releases expire only their own generation, so a stale worker cannot remove a newer lease. Confirmed pre-submit failures retry with backoff. Ambiguous submit outcomes stop permanently in `unknown_outcome` until an authoritative provider-approved recovery exists; they never return to the automatic submit path from a bare operator confirmation.

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
2. Wix triggers the legacy `wixStores_onNewOrder` or modern `wixEcom_onOrderApproved` handler in `src/backend/events.js`.
3. The handler persists the full order in `ISendOrderOutbox`; it does not call iSend.
4. The hourly scheduled worker claims a bounded batch and calls `sendOrderToISend` only inside 10:00-22:00 MYT.
5. A business-success response with queryable `custOrderNo` is saved in `ISendOrderMap` before the outbox row becomes `sent`; `orderNo` and `orderId` alone remain quarantined until the partner confirms their semantics.
6. When iSend sends a webhook, `post_isendWebhook` authenticates the exact raw bytes and calls `handleWebhook`.
7. `handleWebhook` checks idempotency and routes the payload:
   - Tracking events create Wix fulfillments.
   - Status events update order mapping status.
   - Inventory events update `ISendInventory`.
8. The poller in `src/backend/isendPoller.js` can also regularly query iSend and keep status/tracking in sync.
9. When a mapped order becomes delivered, `handleDelivered` records the event and creates a pending email.

---

## Notes for new programmers

- The backend code uses Wix collections to store state:
  - `ISendOrderMap`
  - `ISendOrderOutbox`
  - `ISendOrderOutboxClaims`
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
