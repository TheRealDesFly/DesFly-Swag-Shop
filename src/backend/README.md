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

- Webhook endpoint: `POST /_functions/isendWebhook` — expects HMAC-SHA256 signature header `X-ISEND-Signature` using secret `ISTORE_ISEND_WEBHOOK_SECRET`.
- Staging diagnostic: `GET /_functions/testISendLoginFromWix` — protected by `X-ISEND-POLLER-SECRET`; it always selects staging and returns session-presence evidence without the iSend root or session values.
- Manual poll trigger: `POST /_functions/runISendPoller` — protected by header `X-ISEND-POLLER-SECRET` matching Wix secret `ISEND_POLLER_TRIGGER_SECRET`; it always uses the site's configured iSend environment.
- Manual outbox recovery: `POST /_functions/requeueISendOrder` — protected by the separate operator-only `X-ISEND-RECOVERY-SECRET` and limited to conclusively pre-submit, retry-exhausted records.
- Manual fulfillment endpoint: `POST /_functions/createFulfillmentFromWix` — protected by header `X-ISEND-FULFILLMENT-SECRET` matching Wix secret `ISEND_FULFILLMENT_TRIGGER_SECRET` and requires a stable `idempotencyKey` bound to the exact fulfillment request.
- Environment selection: set Wix secret `ISTORE_ISEND_ENV` to `staging` or `production`. Production uses only `ISTORE_ISEND_PRODUCTION_URL`; staging uses `ISTORE_ISEND_SANDBOX_URL`.
- iStore/iSend base URLs may be either the Postman host or the API context root with `/IsisWMS-War`; backend code appends `/Json/...` endpoint paths and tries `/IsisWMS-War` automatically for host-only URLs. Verified official roots are `https://staging.istoreisend-wms.com:5191/IsisWMS-War` and `https://istoreisend-wms.com:5191/IsisWMS-War`.
- Login captures the `JSESSIONID` cookie returned by `/Json/Public/login/` and sends it with authenticated order, tracking, and inventory requests.
- The configured service window is 10:00 AM-10:00 PM Malaysia Time.
- Backend iStore/iSend requests use a 20-second timeout so Wix does not wait until a gateway timeout before returning a controlled error.

GitHub Actions workflow is provided to run staging smoke checks. To enable it, add these repository secrets:

- `WIX_SITE_BASE_URL` — e.g. `https://your-site.com` (no trailing slash)
- `ISTORE_ISEND_API_USER_ID`
- `ISTORE_ISEND_API_PASSWORD`
- `ISTORE_ISEND_SANDBOX_URL`
- `ISEND_POLLER_TRIGGER_SECRET`

Workflow:
- `.github/workflows/isend-staging-smoke.yml` — runs locked install, lint, tests, and offline smoke validation on pull requests/pushes. It runs strict direct-plus-Wix live probes three times daily or by default-branch manual dispatch inside 10:00-22:00 MYT.

Wix Data collections required:
- `ISendOrderMap` — maps `wixOrderId` ↔ `iSendOrderNo`.
- `ISendOrderOutbox` — stores durable order snapshots and `pending`, `processing`, `retry`, `unknown_outcome`, or `sent` state.
- `ISendOrderOutboxClaims` — stores append-only, deterministic worker-lease generations.
- `ISendProcessedEvents` — stores idempotency keys (`idempotencyKey`).
- `ISendWebhookEvents` — persisted raw webhook events for auditing.
- `ISendInventory` — optional, stores SKU inventory snapshots from webhook events.
- `ISendPendingEmails` — optional, stores pending outbound emails for Wix Automations (fields: `to`, `subject`, `body`, `wixOrderId`, `iSendOrderNo`, `createdAt`, `sent`).

Recommended indexes:
- `ISendOrderMap.wixOrderId` regular; deterministic mapping IDs enforce one mapping per Wix order.
- `ISendOrderMap.iSendOrderNo` unique so one iSend order cannot map to two Wix orders.
- `ISendProcessedEvents.idempotencyKey` unique; deterministic IDs plus a legacy-row pre-read protect upgraded code, and the index closes old/new deployment races.
- `ISendOrderOutbox.orderKey`, `(status, nextAttemptAt)`, `(status, retryExhausted)`, and `(status, leaseExpiresAt)`.
- `ISendOrderOutboxClaims.(claimKey, generation)` compound and `leaseExpiresAt` regular.

Keep all integration collections Admin-only. Deterministic `_id` values provide the outbox, mapping, and side-effect claim concurrency boundary; monotonic claim generations fence stale workers without deleting and reusing a claim ID. The custom indexes improve performance and add defense in depth. The hourly scheduled worker processes five orders per run inside the MYT service window, so load-test the 60-order daily capacity before production.

In Wix Data, configure `ISendOrderOutbox.attemptCount`, `maxAttempts`, and `claimGeneration` as Number; `retryExhausted` as Boolean; all `*At` and `leaseExpiresAt` values as Date and Time; and snapshots/diagnostics as Object. Configure `ISendOrderOutboxClaims.generation` as Number (never Text), its lifecycle fields as Date and Time, and its identity/token fields as Text. Preserve the newest claim generation for every order; older released generations can be archived by a future retention job only after a safe interval.

### Webhook secret

- Set a Backend-only Wix Secret named `ISTORE_ISEND_WEBHOOK_SECRET`. Do NOT commit the secret value to source control.
- The webhook endpoint `POST /_functions/isendWebhook` expects an `X-ISEND-Signature` header with value `sha256=<hex>` where `<hex>` is the HMAC-SHA256 of the raw request body using the secret above.

Example (generate signature in Node):

```
node -e "const crypto=require('crypto'); const secret=process.env.WEBHOOK_SECRET; const body=process.argv[1] || '{}'; console.log('sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex'))" '{"test":true}'
```

Example `curl` test (replace `<SIG>` and `<SITE_URL>`):

```
curl -X POST "<SITE_URL>/_functions/isendWebhook" \
  -H "Content-Type: application/json" \
  -H "X-ISEND-Signature: sha256=<SIG>" \
  -d '{"orderNo":"TEST123","tracking":{"trackingNo":"TN12345"}}'
```

### Poll trigger

Store the poller trigger secret as a Backend-only Wix Secret named `ISEND_POLLER_TRIGGER_SECRET`.
Call `POST /_functions/runISendPoller` with `X-ISEND-POLLER-SECRET`.
The poller syncs tracking and order status by default. Inventory polling is not enabled until the iStore inventory API contract is confirmed.

The staging diagnostic uses the poller trigger secret; the outbox recovery endpoint instead uses `ISEND_RECOVERY_TRIGGER_SECRET`, which must not be shared with automated monitoring. Recovery accepts only retry-exhausted records whose failures were conclusively before submit. Ambiguous `unknown_outcome` records cannot be automatically requeued: a timed-out request may complete after an operator checks, so quarantine the row and reconcile it with iSend support until an authoritative idempotent recovery contract exists.

Fulfillment claims live in `ISendProcessedEvents` under canonical tracking keys. Only `meta.status=completed` is a safe duplicate. Reconcile `processing` or `unknown_outcome` against the Wix order's actual fulfillments; mark an existing fulfillment completed, or remove the single claim only after authoritative confirmation that no fulfillment exists. Delivery audit/email writes use deterministic IDs and retry on every `DELIVERED` report; email consumers must mark queue rows sent instead of deleting them.

### DELIVERED handling

When the iStore/iSend status maps to `DELIVERED` the integration will:

- Update the mapping record in `ISendOrderMap.meta` with `deliveryTimestamp`, `lastKnownISendStatus`, and `lastStatusUpdatedAt`.
- Persist a `DELIVERED` audit event in `ISendWebhookEvents`.
- Create a pending email record in the `ISendPendingEmails` collection with the default delivery email subject and body.

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
- On scheduled or manual default-branch runs inside 10:00-22:00 MYT, require both direct iSend staging login and the protected `/_functions/testISendLoginFromWix?env=staging` probe to complete with authenticated-session evidence. Outside-window manual requests and non-default-branch live requests fail explicitly.

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
