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

Production must set `ISTORE_ISEND_ENV` to `production`. The backend now uses the production URL only when that environment is selected, and it no longer falls back from production to staging.

## Local Staging Smoke Test

Set these local environment variables when testing from your machine:

- `ISTORE_ISEND_API_USER_ID`
- `ISTORE_ISEND_API_PASSWORD`
- `ISTORE_ISEND_SANDBOX_URL`
- `ISTORE_ISEND_STORAGE_CLIENT_NO`
- `WIX_SITE_BASE_URL`

Use the iStore/iSend host or API context root for `ISTORE_ISEND_SANDBOX_URL`. The backend appends `/Json/...` paths and automatically tries the `/IsisWMS-War` context root when the configured URL is host-only.

Verified official context roots:

- Staging: `https://staging.istoreisend-wms.com:5191/IsisWMS-War`
- Production: `https://istoreisend-wms.com:5191/IsisWMS-War`
- Alternate web API host supplied for testing: `https://webapi.istoreisend-wms.com/IsisWMS-War`

You can put these values in an untracked `.env` file. Start from `.env.example`; the smoke script loads `.env` automatically and does not print secret values.

Check whether local configuration is present:

```bash
npm run check:staging:setup
```

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

The script performs whichever checks it has enough configuration for:

- Direct iSend staging login using local iSend credentials. The check reports whether login returned a `JSESSIONID` session cookie, but never prints the cookie value.
- Published Wix endpoint check at `/_functions/testISendLoginFromWix?env=staging`.
- Direct inventory query when `--inventory` is provided; it logs in first and sends the returned iSend session cookie/session fields with the inventory request.

It does not print secret values. Live iSend and Wix login probes are skipped outside the configured 10:00 AM-10:00 PM Malaysia Time service window unless you pass `--force`.

To intentionally test outside the service window:

```bash
npm run check:staging -- --force --inventory
```

## Troubleshooting Local Smoke Tests

- iStore/iSend staging may only be active during the partner-provided service window. Current code uses 10:00 AM-10:00 PM Malaysia Time.
- `skipped: true` with `Outside iStore iSend service window`: the command did not call iSend because the current Malaysia Time is outside the configured staging window. Run again during the window or pass `--force` for an intentional live probe.
- `connect ETIMEDOUT [address]` on `direct-isend-staging`: the configured iSend staging host is not reachable from the local network on its configured port. Check VPN, firewall, allowlist, endpoint host, and whether the iSend staging service is up.
- `Wix staging iSend endpoint failed with status 404`: `WIX_SITE_BASE_URL` is reachable, but the published site at that URL does not expose `/_functions/testISendLoginFromWix`. Check that the URL points to the intended Wix site/environment and that the backend code is published there.
- `unable to verify the first certificate`: on Windows, retry with Node's system certificate store, for example `NODE_OPTIONS=--use-system-ca npm run check:staging`.
- The default local smoke-test timeout is 20 seconds. Override it with `CHECK_ISEND_TIMEOUT` or `--timeout` when diagnosing slow networks.

`npm run check:staging:diagnose` reports Wix route status codes and iSend port reachability without printing the configured hostnames or secrets.

## GitHub Actions Secrets

For `.github/workflows/isend-staging-smoke.yml`, configure:

- `ISTORE_ISEND_API_USER_ID`
- `ISTORE_ISEND_API_PASSWORD`
- `ISTORE_ISEND_SANDBOX_URL`
- `WIX_SITE_BASE_URL`

The workflow installs dependencies, runs lint, and runs the local staging smoke script.
