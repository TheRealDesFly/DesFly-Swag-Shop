# DesFly iStore Development Environment

Use this runbook to prepare and verify the local development environment before creating a Wix preview or publishing reviewed code. Local development uses only the iStore iSend staging/sandbox API. Wix is the production runtime and is not required for the local development gates.

## 1. Prerequisites

- Git and repository access.
- A Node.js version allowed by `package.json`: Node 20.19+, 22.12+, or 24+.
- npm and the repository's lockfile.
- Approved iStore iSend sandbox credentials supplied through a private channel.
- Wix access only when creating a preview or performing an approved publication.

From a new checkout, install exactly the locked dependencies:

```powershell
npm ci
```

On Windows systems that block `npm.ps1`, use `npm.cmd` for every command in this document, for example `npm.cmd ci`. Use the project-local Wix CLI through `npm exec wix --`; a global Wix CLI installation is not required.

## 2. Private local configuration

Copy `.env.example` to the untracked `.env` file without overwriting an existing file. Populate only approved values and never paste them into issues, chat, logs, commits, screenshots, or retained test output.

The local runtime requires these nonempty values:

- `ISTORE_ISEND_API_USER_ID`
- `ISTORE_ISEND_API_PASSWORD`
- `ISTORE_ISEND_SANDBOX_URL`
- `ISTORE_ISEND_STORAGE_CLIENT_NO`
- `ISTORE_ISEND_ORDER_ORIGIN`
- `ISTORE_ISEND_ENV=staging`

All production placeholders remain blank for normal staging development. Populate `ISTORE_ISEND_PRODUCTION_API_USER_ID`, `ISTORE_ISEND_PRODUCTION_API_PASSWORD`, `ISTORE_ISEND_PROD_STORAGE_CLIENT_NO`, `ISTORE_ISEND_PRODUCTION_ORDER_ORIGIN`, and `ISTORE_ISEND_PRODUCTION_URL` in the ignored local `.env` only for an explicit, read-only production connectivity check; production runtime values also belong in Wix Secrets Manager. `WIX_SITE_BASE_URL` and `ISEND_POLLER_TRIGGER_SECRET` are optional production-verification inputs and are not required for development or direct staging iSend connectivity.

## 3. Offline development gates

Validate Node, locked dependencies, Wix project metadata, `.env` protection, required runtime keys, the staging selector, and the approved sandbox endpoint without making a network request:

```powershell
npm run check:dev:setup
```

Run the complete offline development gate—setup validation, lint, and the local Wix/iSend diagnostic contract tests:

```powershell
npm run check:dev
```

The mocked diagnostic tests use the real backend modules with mocked Wix Secrets Manager and `wix-fetch`. They cover session fields/cookies, URL validation, network failure, timeout, redirect, invalid responses, HTTP failures, rejected authentication, and missing sessions. They must not call order, inventory, tracking, fulfillment, webhook, or poller endpoints.

## 4. Read-only live sandbox connectivity

After the offline gate passes, explicitly run the direct read-only sandbox login:

```powershell
npm run check:dev:live
```

This command uses `--skip-wix --force --require-live`. It may authenticate outside the normal partner service window, but it calls only the iSend login endpoint. It does not query inventory and cannot create or modify orders, inventory, refunds, fulfillment, tracking, or other iSend data.

A valid pass reports HTTP 200 plus authenticated session-presence evidence. It never prints credentials, configured hostnames, cookies, or session values. A neutral or skipped result is not a pass. If Windows cannot verify the certificate chain, retry from the same terminal with the system certificate store enabled:

```powershell
$env:NODE_OPTIONS='--use-system-ca'
npm run check:dev:live
```

## 5. Candidate, preview, and publication gates

1. Run `npm run check:dev` and `npm run check:dev:live`.
2. Review the exact changed-file diff and confirm no secret or unrelated file is present.
3. Commit and push the candidate; require local `HEAD` to equal its upstream SHA.
4. Create a Wix preview from the clean reviewed candidate. A preview validates the candidate but is not production proof.
5. Merge through review, then publish remote `main` without `--force` only after explicit publication approval.
6. During 09:00-23:00 MYT, run the protected Wix GET staging diagnostic. Staging proof requires HTTP 200, the reviewed diagnostic build marker, `environment=staging`, and authenticated session-presence evidence.
7. After the authorized selector cutover, run `npm run check:production`. It requires both a direct production login and the protected Wix production login diagnostic to return authenticated-session evidence from the reviewed build without sending an order.

Never weaken the Wix production service-window guard to make a development test pass. Use sanitized diagnostic classifications to identify the next reviewed fix.

## Expected outcomes

- `check:dev:setup`: `passed` only when the workstation and staging-only configuration are ready.
- `check:dev`: nonzero if setup, lint, or a diagnostic contract test fails.
- `check:dev:live`: `passed` only after a real direct sandbox login returns authenticated-session evidence.
- Wix preview/publication: separate reviewed gates; neither is implied by a local pass.
