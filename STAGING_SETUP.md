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
- `WIX_SITE_BASE_URL`

You can put them in an untracked `.env` file. Start from `.env.example`; the smoke script loads `.env` automatically and does not print secret values.

Then run:

```bash
npm run check:staging
```

The script performs whichever checks it has enough configuration for:

- Direct iSend staging login using local iSend credentials.
- Published Wix endpoint check at `/_functions/testISendLoginFromWix?force=true&env=staging`.

It does not print secret values.

## GitHub Actions Secrets

For `.github/workflows/isend-staging-smoke.yml`, configure:

- `ISTORE_ISEND_API_USER_ID`
- `ISTORE_ISEND_API_PASSWORD`
- `ISTORE_ISEND_SANDBOX_URL`
- `WIX_SITE_BASE_URL`

The workflow installs dependencies, runs lint, and runs the local staging smoke script.
