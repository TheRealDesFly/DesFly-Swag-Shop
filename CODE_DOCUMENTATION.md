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
  - Returns success when iSend responds with a valid login.

- `main()` (anonymous async IIFE)
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

- `hasProcessed(idempotencyKey)`
  - Checks the `ISendProcessedEvents` collection for the given key.
  - Returns `true` if the key was already recorded.

- `markProcessed(idempotencyKey, meta = {})`
  - Inserts a new record into `ISendProcessedEvents`.
  - Stores optional metadata along with the key.

- `claimProcessed(idempotencyKey, meta = {})`
  - Inserts a processing claim before an external side effect.
  - Returns a duplicate result when the idempotency key already exists.

- `updateProcessed(idempotencyKey, meta = {})`
  - Updates metadata for an existing idempotency key.

- `releaseProcessed(idempotencyKey)`
  - Removes a processing claim after a failed side effect so a future retry can run.

This pattern is used by webhook processing and fulfillment creation to avoid duplicate work.

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
  - If the status transitions to `DELIVERED`, it triggers `handleDelivered`.

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
  - Supports `lineItems`, `trackingNumber`, `shippingProvider`, `trackingLink`, and `idempotencyKey`.
  - Uses `wixStoresBackend.createFulfillment` to create the fulfillment.
  - Records the idempotency key so the same tracking update is not processed twice.

This is the function used by both webhook handling and polling.

---

## src/backend/orderStateTransitions.js

This module handles the transition when an iSend order becomes delivered.

Functions:

- `handleDelivered(iSendOrderNo, options = {})`
  - Finds the mapping for the iSend order number.
  - Updates the mapping metadata with delivery timestamps.
  - Records a `DELIVERED` event in `ISendWebhookEvents`.
  - Attempts to find the buyer email from the Wix order.
  - Creates a pending email record in `ISendPendingEmails` so an email can be sent later.

This helper is triggered automatically when status sync detects a delivery event.

---

## src/backend/isendPoller.js

This module polls iSend for updates on mapped orders.

Functions:

- `extractTrackingNumbers(obj)`
  - Recursively scans an object for strings that look like tracking numbers.

- `runPoller(options = {})`
  - Loads mappings from `ISendOrderMap`.
  - For each mapping, calls `getTrackingInfo`.
  - Updates stored status via `updateMappingStatus`.
  - Creates fulfillment records in Wix if new tracking numbers are found.
  - Optionally supports inventory sync in the future.

This is the fallback/background mechanism for keeping Wix and iSend in sync.

---

## src/backend/http-functions.js

This file exposes Wix HTTP endpoints.

Functions:

- `get_testISendLoginFromWix(request)`
  - HTTP GET endpoint used to validate iSend login from the site.

- `post_isendWebhook(request)`
  - HTTP POST endpoint for receiving iSend webhooks.

- `post_runISendPoller(request)`
  - HTTP POST endpoint to trigger the poller.
  - Protected by header `X-ISEND-POLLER-SECRET` and the Wix secret `ISEND_POLLER_TRIGGER_SECRET`.

- `post_createFulfillmentFromWix(request)`
  - HTTP POST endpoint to create a Wix fulfillment from an external request.
  - Protected by header `X-ISEND-FULFILLMENT-SECRET` and the Wix secret `ISEND_FULFILLMENT_TRIGGER_SECRET`.

This file connects backend logic to external HTTP calls.

---

## src/backend/events.js

This is the Wix event handler file.

- `wixStores_onNewOrder(event)`
  - Triggered automatically when a new Wix store order is created.
  - Skips processing when a Wix-to-iSend mapping already exists.
  - Sends the new order to iSend.
  - Saves the mapping between the Wix order and the iSend order number.

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
2. Wix triggers `wixStores_onNewOrder` in `src/backend/events.js`.
3. The order is sent to iSend using `sendOrderToISend`.
4. The iSend order number is saved in `ISendOrderMap` via `saveMapping`.
5. When iSend sends a webhook, `post_isendWebhook` calls `handleWebhook`.
6. `handleWebhook` verifies the webhook, checks idempotency, and routes the payload:
   - Tracking events create Wix fulfillments.
   - Status events update order mapping status.
   - Inventory events update `ISendInventory`.
7. The poller in `src/backend/isendPoller.js` can also regularly query iSend and keep status/tracking in sync.
8. When a mapped order becomes delivered, `handleDelivered` records the event and creates a pending email.

---

## Notes for new programmers

- The backend code uses Wix collections to store state:
  - `ISendOrderMap`
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
4. Read `src/backend/isendWebhookHandler.js` to understand webhook processing.
5. Read `src/backend/isendPoller.js` to understand the fallback sync mechanism.
6. Read `src/backend/orderFulfillment.js` and `src/backend/orderStateTransitions.js` for fulfillment and delivery behavior.
7. Read `src/backend/isendMappings.js` and `src/backend/isendStatusMapping.js` for persistence and status normalization.
