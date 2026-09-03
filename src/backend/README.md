# The Backend Code Folder

This folder contains the backend code files for your site. These files correspond to the ones found in the [**Backend**](https://support.wix.com/en/article/velo-working-with-the-velo-sidebar#backend) section of the **Public & Backend** 
![image](https://user-images.githubusercontent.com/89579857/184862813-e55cdd98-b723-4d64-b73c-593eb9af21c7.png) tab in the Velo sidebar. Add the following files to this folder to include them in your site:
+ [**Web Modules:**](https://support.wix.com/en/article/velo-web-modules-calling-backend-code-from-the-frontend)  
  These are files that allow you to expose functions in your site's backend that you can run in your frontend code. These files require a `.jsw` file extension.
  >**Note:**  
  >You can't change [web module permissions](https://support.wix.com/en/article/velo-about-web-module-permissions) in Wix editors when using Git Integration & Wix CLI. Instead, use the [permissions.json](#permissionsjson) file to set function permissions.

+ **data.js**  
  A file for [adding data hooks](https://support.wix.com/en/article/velo-using-data-hooks) to your site's collections.

+ **routers.js**  
  A file for implementing [routing and sitemap](https://support.wix.com/en/article/velo-about-routers#routing-code) functionality for your site.

+ **events.js**  
  A file for implementing your site's [backend event handlers](https://support.wix.com/en/article/velo-backend-events). 

+ **http-functions.js**  
  A file for implementing [HTTP endpoints](https://www.wix.com/velo/reference/wix-http-functions/introduction) that are exposed on your site.

+ **jobs.config**  
  A file for [scheduling recurring jobs](https://support.wix.com/en/article/velo-scheduling-recurring-jobs). Jobs consist of other backend code that's run at regular intervals.
  
+ **General backend files**  
  JavaScript code files. You can import code from these files into any other backend file on your site. These files require a `.js` file extension.

Use the following syntax to import code from backend files: 
```js 
import { myFunctionName } from 'backend/myFileName';
```  
Trying to import from the relative path in your site's repo doesn't work.

Learn more about [this repo's file structure](https://support.wix.com/en/article/velo-understanding-your-sites-github-repository-beta).

## permissions.json
This file defines [permissions](https://support.wix.com/en/article/velo-about-web-module-permissions) for the functions in your web module files. The file contains a key, `"web-methods"`, whose value is an object that can contain keys named after the web module files in your `backend` folder. Name these keys with the following syntax: `"backend/{path to file}myFile.jsw"`. The value for each file name key is an object that can contain keys named after the functions in that file. Each function key has a value with the following format:
```js
"backend/myFile.jsw": {
  "siteOwner" : {
    "invoke" : // Boolean
  },
  "siteMember" : {
    "invoke" : // Boolean
  },
  "anonymous" : {
    "invoke" : // Boolean
  }  
}
```

## iStore / iSend Integration Notes

This repo includes an iStore/iSend integration with webhook receiver and a poller.

- Webhook endpoint: `POST /_functions/isendWebhook` — expects HMAC-SHA256 signature header `X-ISEND-Signature` using secret `ISTORE_ISEND_WEBHOOK_SECRET`. Routing uses only signed body `eventType`/`type`, and dedupe uses signed body `deliveryId`/`eventId` or the body hash; unsigned event/delivery-ID headers are ignored.
- Staging diagnostic: `GET /_functions/testISendLoginFromWix` — protected by `X-ISEND-POLLER-SECRET`; it runs only when the site's authoritative `ISTORE_ISEND_ENV` is staging, ignores caller environment/force overrides, and returns the reviewed diagnostic build marker plus session-presence evidence. Failures expose only an allowlisted phase/class, attempt count, upstream-response presence, and optional numeric status; roots, paths, raw errors, response bodies, cookies, and session values are never returned or logged.
- Production-selected staging diagnostic: `GET /_functions/testISendStagingLoginFromProductionWix` — protected by the distinct `X-ISEND-STAGING-DIAGNOSTIC-SECRET`; it performs only a staging login, honors the staging service window, ignores caller overrides, and never changes `ISTORE_ISEND_ENV` or runs order/poller/fulfillment work.
- Production diagnostic: `GET /_functions/testISendProductionLoginFromWix` — protected by the same diagnostic header and disabled until the authoritative site environment is production. It forces only a read-only login check so cutover can be verified outside staging support hours; it cannot submit orders, query inventory, run the poller, or create fulfillments. Run it with `npm run check:production` after the selector changes.
- Manual poll trigger: `POST /_functions/runISendPoller` — protected by header `X-ISEND-POLLER-SECRET` matching Wix secret `ISEND_POLLER_TRIGGER_SECRET`; it always uses the site's configured iSend environment and the fixed scheduled-safety-net bounds of five active mappings, one page, and reconciliation-only tracking/status work.
- Manual outbox recovery: `POST /_functions/requeueISendOrder` — protected by the separate operator-only `X-ISEND-RECOVERY-SECRET` and limited to conclusively pre-submit, retry-exhausted records.
- Protected fulfillment endpoint: `POST /_functions/createFulfillmentFromWix` — protected by header `X-ISEND-FULFILLMENT-SECRET`, requires `orderId`, mapped `iSendOrderNo`, and one tracking number, uses the configured environment, and routes through the same order-level single-parcel coordinator as webhooks/polling. The coordinator fetches the authoritative Wix order and always fulfills its complete line-item/quantity set; any supplied line-item list must match exactly. A supplied `idempotencyKey` is accepted only when it equals `isend:<environment>:<iSendOrderNo>:single-parcel-fulfillment`; callers cannot choose a second key. Fulfillment also requires backend secret `ISTORE_ISEND_SINGLE_PARCEL_CONTRACT_CONFIRMED` to equal `true`; absent, unreadable, or other values fail closed until the partner contract is approved.
- Environment selection: set Wix secret `ISTORE_ISEND_ENV` to `staging` or `production`. Production uses only `ISTORE_ISEND_PRODUCTION_API_USER_ID`, `ISTORE_ISEND_PRODUCTION_API_PASSWORD`, `ISTORE_ISEND_PROD_STORAGE_CLIENT_NO`, `ISTORE_ISEND_PRODUCTION_ORDER_ORIGIN`, and `ISTORE_ISEND_PRODUCTION_URL`; staging uses the existing staging credential names and `ISTORE_ISEND_SANDBOX_URL`. Production never falls back to staging credentials. New outbox rows and mappings persist the normalized environment, and workers refuse missing or mismatched bindings so changing the selector cannot redirect old work.
- Deployment binding: set backend secret `ISTORE_ISEND_DEPLOYED_REVISION` to the exact reviewed 40-character source SHA being published. Operational health rejects missing/malformed values and capacity evidence from a different revision.
- iStore/iSend base URLs must use HTTPS and may be either an approved host root or its `/IsisWMS-War` context root. One owner-approved private origin may use `/api/login` only in staging and only when its reviewed SHA-256 origin fingerprint matches. Public staging and all production origins reject that path. URL credentials, query strings, fragments, other paths, unapproved hosts/ports, and redirects fail closed before credentials or order data are sent.
- The partner-provided production web API origin is approved for production. Use the partner's production API-access identity for `ISTORE_ISEND_PRODUCTION_API_USER_ID`; do not substitute the separate Odin user ID.
- Login captures the `JSESSIONID` cookie returned by `/Json/Public/login/` and sends it with authenticated order, tracking, and inventory requests.
- The partner-provided staging service window is 9:00 AM-11:00 PM Malaysia Time.
- Outbound order dates are formatted explicitly in `Asia/Kuala_Lumpur`, independent of the Wix runtime or developer-machine timezone.
- Backend iStore/iSend requests use one 20-second deadline covering connection, response headers, and response-body consumption; expiry aborts the underlying fetch before returning a controlled error.

GitHub Actions workflow is provided to run staging smoke checks. To enable it, add these repository secrets:

- `WIX_SITE_BASE_URL` — e.g. `https://your-site.com` (no trailing slash)
- `ISTORE_ISEND_API_USER_ID`
- `ISTORE_ISEND_API_PASSWORD`
- `ISTORE_ISEND_SANDBOX_URL`
- `ISEND_POLLER_TRIGGER_SECRET`

Workflow:
- `.github/workflows/isend-staging-smoke.yml` — runs locked install, lint, tests, and offline smoke validation on pull requests/pushes. It runs strict direct-plus-Wix live probes three times daily or by default-branch manual dispatch inside 09:00-23:00 MYT.

Wix Data collections required:
- `ISendOrderMap` — maps `wixOrderId` ↔ `iSendOrderNo`, binds that identity to an iSend environment, and stores reconciliation scheduling state.
- `ISendOrderOutbox` — stores environment-bound durable order snapshots and `pending`, `processing`, `retry`, `unknown_outcome`, `sent`, or `canceled` state plus lifecycle attention.
- `ISendOrderLifecycleIntents` — stores append-only environment-bound update/cancellation intents before claim acquisition; it contains fingerprints/status metadata but no order snapshot or PII.
- `ISendOrderOutboxClaims` — stores append-only, deterministic worker-lease generations and namespaced mapping-mutation leases.
- `ISendMaintenanceState` — stores the deterministic keyset cursor for bounded claim-retention scans.
- `ISendProcessedEvents` — stores idempotency keys (`idempotencyKey`).
- `ISendWebhookEvents` — stores environment-bound raw webhook and delivery audit events.
- `ISendInventory` — required if inventory webhook events are accepted; stores deterministic environment/SKU inventory snapshots. Inventory polling remains disabled until the partner contract is approved.
- `ISendPendingEmails` — required for the delivered-email path; stores environment-bound pending records for Wix Automations (fields: `to`, `subject`, `body`, `wixOrderId`, `iSendOrderNo`, `environment`, `createdAt`, `sent`, `source`).

Recommended indexes:
- `ISendOrderMap.wixOrderId` regular; deterministic mapping IDs enforce one mapping per Wix order.
- `ISendOrderMap.iSendOrderNo` unique so one customer-order identity cannot resolve to two Wix orders. This remains global and fail-closed until cross-environment reuse can be authenticated safely.
- `ISendOrderMap.(environment, reconciliationActive, lastReconciledAt)` compound regular index for the bounded current-environment safety net.
- `ISendProcessedEvents.idempotencyKey` unique; deterministic IDs plus a legacy-row pre-read protect upgraded code, and the index closes old/new deployment races.
- `ISendOrderOutbox.(status, environment, nextAttemptAt)` and `(status, environment, leaseExpiresAt)`, plus `lifecycleRequiresAttention`. The retry-exhausted health query is scoped to the current environment and uses the status/environment prefix of the queue indexes; mismatch and unassigned scans cover other environment states.
- `ISendOrderLifecycleIntents.(orderKey, environment, recordedAt descending)`.
- `ISendOrderOutboxClaims.(claimKey ascending, generation descending)` compound; `leaseExpiresAt` and `releasedAt` regular. Retention also requires target-site query-plan proof for `releasedAt` plus `_id` cursor/order and empty `releasedAt` plus `leaseExpiresAt`; block deletion if the plan needs a different compound-index/cursor design.
- `ISendInventory.(environment, sku)` compound regular; a deterministic environment/SKU `_id` is the concurrency identity boundary.
- `ISendPendingEmails.(environment, sent, createdAt)` compound regular for health monitoring.

Keep all integration collections Admin-only. Deterministic `_id` values provide the outbox, lifecycle-intent, mapping, and side-effect claim concurrency boundary; monotonic claim generations fence stale workers without deleting and reusing a claim ID. Namespaced mapping-mutation claims serialize full-item Wix Data updates from webhooks and the poller. The hourly outbox and poller each have at most 70 productive service-window slots/day before backlog/retries. The poller requires authoritative `returnObject.totalRecord=1`, exactly one page row, and an exact `custOrderNo` match before it applies status or tracking data. Daily retention uses grouped latest-generation verification and bounded bulk deletion, always preserves the latest/active/unreleased claim generation, and persists incomplete/runtime/partial-delete state. Hourly operational health fails on unresolved outbox lifecycle, fulfillment, retention, storage, deployed-revision/capacity-evidence mismatch, or owner retention/scrubbing-policy state.

Configure every field type and index exactly as listed in `STAGING_SETUP.md`, the authoritative nine-collection schema. In particular, outbox/lifecycle environments and fingerprints are Text; counters/limits are Number; attention/status flags are Boolean; all lifecycle/lease/audit timestamps are Date and Time; and snapshots/diagnostics/provenance are Object. `ISendOrderOutboxClaims.generation` is Number, never Text. Preserve the newest claim generation for every claim key; the retention job removes only old released nonlatest generations. Lifecycle intents are monitored append-only records and require measured storage runway.

Before the first publication, follow the mandatory legacy migration in `STAGING_SETUP.md`: reconcile both mapping identity dimensions independently; convert exactly one proven completed legacy per-tracking fulfillment claim to the order-level single-parcel key; environment-scope proven raw-webhook claims; and prove/backfill environments on outbox, mapping, webhook-audit, inventory, and pending-email rows. Quarantine ambiguity and never infer an environment from the current selector. Before switching to production, drain staging queue work, resolve staging attention states, deactivate terminal staging mappings, and quiesce staging webhook delivery.

### Webhook secret

- Set a Backend-only Wix Secret named `ISTORE_ISEND_WEBHOOK_SECRET`. Do NOT commit the secret value to source control.
- The webhook endpoint `POST /_functions/isendWebhook` expects an `X-ISEND-Signature` header with value `sha256=<hex>` where `<hex>` is the HMAC-SHA256 of the raw request body using the secret above. Request bodies are limited to 1 MiB and oversized requests fail with HTTP 413 before parsing or side effects.

Example (generate signature in Node):

```
node -e "const crypto=require('crypto'); const secret=process.env.WEBHOOK_SECRET; const body=process.argv[1] || '{}'; console.log('sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex'))" '{"test":true}'
```

Example `curl` test (replace `<SIG>` and `<SITE_URL>`):

```
curl -X POST "<SITE_URL>/_functions/isendWebhook" \
  -H "Content-Type: application/json" \
  -H "X-ISEND-Signature: sha256=<SIG>" \
  -d '{"eventType":"tracking.updated","custOrderNo":"TEST123","tracking":{"trackingNo":"TN12345"}}'
```

### Poll trigger

Store the poller trigger secret as a Backend-only Wix Secret named `ISEND_POLLER_TRIGGER_SECRET`.
Call `POST /_functions/runISendPoller` with `X-ISEND-POLLER-SECRET`.
The protected endpoint runs a manual diagnostic poll. A separate staggered hourly `runISendPollerJob` reconciles five active mappings as a safety net for missed signed webhooks and fails the Wix job on partial work. Inventory polling is not enabled until the iStore inventory API contract is confirmed.

The staging diagnostic uses the poller trigger secret; the outbox recovery endpoint instead uses `ISEND_RECOVERY_TRIGGER_SECRET`, which must not be shared with automated monitoring. Recovery accepts only retry-exhausted records whose failures were conclusively before submit. Ambiguous `unknown_outcome` records cannot be automatically requeued: a timed-out request may complete after an operator checks, so quarantine the row and reconcile it with iSend support until an authoritative idempotent recovery contract exists.

Fulfillment claims live in `ISendProcessedEvents` under the environment-scoped one-order key `isend:<environment>:<custOrderNo>:single-parcel-fulfillment`. Only `meta.status=completed` with the exact order/line-item/tracking fingerprint is a safe duplicate; a second tracking number fails closed as a key mismatch. Reconcile `processing` or `unknown_outcome` against all actual Wix fulfillments and remove the single order-level claim only after authoritative confirmation that no fulfillment exists. Delivered audit/email effects run only after the single fulfillment is confirmed; status-only delivery remains pending. Email consumers must mark queue rows sent instead of deleting them.

### DELIVERED handling

When the iStore/iSend status maps to `DELIVERED` the integration will:

- Update the mapping record in `ISendOrderMap.meta` with `deliveryTimestamp`, `lastKnownISendStatus`, and `lastStatusUpdatedAt`.
- Persist a `DELIVERED` audit event in `ISendWebhookEvents`.
- Create a pending email record in the `ISendPendingEmails` collection with the default delivery email subject and body.
- Fail retryably with `isend-delivery-email-missing`, leave the webhook unprocessed, and keep poll reconciliation active if neither buyer nor billing email resolves.

To send the email automatically, create a Wix Automation that triggers on new items in `ISendPendingEmails` and sends the contained `subject`/`body` to the `to` email. Alternatively, replace the pending-email step with a direct call to your transactional email provider by editing `backend/orderStateTransitions.js`.

### GitHub repo secrets and workflows

To run the staging smoke-tests workflow you must add the following **repository** secrets in your GitHub repository (Settings → Secrets & variables → Actions):

- `WIX_SITE_BASE_URL` — e.g. `https://your-site.com` (no trailing slash)
- `ISTORE_ISEND_API_USER_ID`
- `ISTORE_ISEND_API_PASSWORD`
- `ISTORE_ISEND_SANDBOX_URL`
- `ISEND_POLLER_TRIGGER_SECRET`

Once the secrets are added and you've pushed these workflow files to `main` (or your default branch), go to the Actions tab and run the `iSend Staging Smoke Tests` workflow (or trigger it via the `Run workflow` button). The workflow will:

- Run `npm ci`, lint, unit tests, and secret-free smoke configuration checks on every pull request and push.
- On scheduled or manual default-branch runs inside 09:00-23:00 MYT, require both direct iSend staging login and the protected `/_functions/testISendLoginFromWix` probe to complete with authenticated-session evidence. Outside-window manual requests and non-default-branch live requests fail explicitly.

Make sure the Wix site is published and the Backend Secrets are set (Backend-only) before running the workflow.

These values reflect the different levels of web module function permissions. You can set them using the following options:
| |`siteOwner`|`siteMember`|`anonymous`|
|-|-----------|------------|-----------|
|Owner-only access| `true` | `false` | `false`|
|Site member access| `true` | `true` | `false`|
|Anyone can access| `true` | `true`| `true`|

The `"web-methods"` object must also contain a `"*"` key. The value for this key defines the default permissions that are applied to any function whose permissions you don't set manually.

Here is an example `permissions.json` file for a site with a backend file called `helperFunctions.jsw`. The file's functions are called `calculate`, `fetchData`, and `syncWithServer`. In this case anyone can call `calculate`, site members can call `syncWithServer`, and only site owners can call `fetchData`.

```json
{
  "web-methods": {
    "*": {
      "*": {
        "siteOwner": {
          "invoke": true
        },
        "siteMember": {
          "invoke": true
        },
        "anonymous": {
          "invoke": true
        }
      }
    },
    "backend/helperFunctions.jsw": {
      "calculate": {
        "siteOwner": {
          "invoke": true
        },
        "siteMember": {
          "invoke": true
        },
        "anonymous": {
          "invoke": true
        }
      },
      "fetchData": {
        "siteOwner": {
          "invoke": true
        },
        "siteMember": {
          "invoke": false
        },
        "anonymous": {
          "invoke": false
        }
      },
      "syncWithServer": {
        "siteOwner": {
          "invoke": true
        },
        "siteMember": {
          "invoke": true
        },
        "anonymous": {
          "invoke": false
        }
      }
    }
  }
}
```
