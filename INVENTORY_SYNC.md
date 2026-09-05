# iStore inventory reconciliation

Implemented: protected preview and bounded maintenance-only stock reconciliation
for Wix Catalog V1. **Not continuous inventory sync and not release evidence.**
The scheduled order poller and webhook remain unable to change Wix Stores stock.
Webhooks still store observations in `ISendInventory`; malformed/missing quantities
now return 400 instead of being silently converted to zero.

## Configuration

Set distinct `ISEND_INVENTORY_TRIGGER_SECRET` values securely in the ignored local
`.env` and Wix Secrets Manager (the same value on both sides). Do not reuse an
order-poller or webhook credential. Configure `ISEND_INVENTORY_SYNC_CONFIG` in Wix:

```json
{"environment":"production","country":"PARTNER_CONFIRMED_COUNTRY","mode":"preview"}
```

The environment must match `ISTORE_ISEND_ENV`. Request bodies cannot override
environment, country, credentials, quantities or maintenance gates. The CLI uses
the existing approved `WIX_SITE_BASE_URL` allowlist; it contacts the published Wix
backend, not a locally running Wix server. Local `.env` alone does not configure Wix.
Staging inventory is preview-only on this shared production storefront: changing
the selector does not create a separate Wix catalog, so staging apply is rejected.

## Read-only preview

After deploying the code and configuring the two secrets:

```powershell
npm run check:inventory -- --sku EXACT-SKU-1 --sku EXACT-SKU-2
```

`POST /_functions/runISendInventorySync` uses `x-isend-inventory-secret` and a body
`{"mode":"preview","skus":["EXACT-SKU-1"]}`. Preview reads only, including no CMS
claim or snapshot writes. It returns exact product/variant IDs, before/after stock,
blockers, and a `planHash`. `ready` means the data plan is valid, **not** that apply
is enabled or the store is production-ready.

- One to five explicit, case-sensitive SKUs per request; no fuzzy matching.
- Reads the visible Catalog V1 product collection (up to 1,000 products), joining
  managed variant SKUs to actual inventory variant IDs. Products omitted by the
  Wix app collection, including hidden products, are outside this tool's scope.
- Each SKU is queried from iStore with page size 1,000. An incomplete page,
  unexpected SKU, ambiguous row, wrong client/country, invalid quantity, missing
  SKU or untracked Wix stock blocks the batch. Missing does **not** mean zero.
- Uses `availableQty`, never `goodQty`, damaged stock, or a guessed sum across
  locations. `0` is a legitimate sellable quantity; replenishment uses a larger
  absolute quantity. No quantity changes are sent to iStore.
- Production reads do not inherit staging's opening hours. Staging still honors
  its service window. No cached webhook quantity is used for a write.

## Controlled baseline apply

First confirm with iStore what `availableQty` excludes (reserved, allocating and
processing quantities), country scope, and how Wix orders affect those numbers.
Pause checkout and other inventory writers; drain/reconcile all orders that Wix
has accepted but the warehouse has not yet reserved. **The code cannot pause
checkout or prove these facts; the configuration is an operator attestation.**
Never set that attestation simply to bypass the gate. Keep the catalog unchanged
during the operation, including visibility, SKU ownership and variant structure.

For that maintenance window only, set this Wix configuration using actual times
with `maintenanceUntil` no more than 15 minutes after `maintenanceStartedAt`:

```json
{
  "environment": "production",
  "country": "PARTNER_CONFIRMED_COUNTRY",
  "mode": "maintenance-apply",
  "availableQtyContractConfirmed": true,
  "checkoutPausedAndOrdersReconciled": true,
  "allowedSkus": ["EXACT-SKU-1"],
  "maintenanceStartedAt": "ACTUAL_UTC_START",
  "maintenanceUntil": "ACTUAL_UTC_END"
}
```

Run preview, inspect every entry, then use that hash and identical SKU scope:

```powershell
npm run check:inventory -- --sku EXACT-SKU-1 --apply --plan-hash HASH_FROM_PREVIEW
```

Apply takes a site-wide distributed lease using the existing Admin-only
`ISendOrderOutboxClaims` collection. It rebuilds the entire plan and rejects a
changed hash. Before each write it checks the environment, maintenance window,
SKU allowlist, snapshot age (60 seconds), current Wix stock and lease ownership.
It sends absolute stock quantities through
`wixStoresBackend.updateInventoryVariantFieldsByProductId` and verifies read-back.
It does not toggle quantity tracking for untracked products.

A failed/ambiguous write or mismatched read-back stops the batch immediately;
there is no automatic retry or rollback. `written` counts **read-back-verified**
writes only. A stopped entry may already have changed stock; inspect it with a
new read-only preview before considering another apply. The batch is not atomic.
Set configuration back to `mode: preview` after maintenance. Expiry also blocks
further apply calls. The lock coordinates this tool's workers only, not checkout
or other inventory integrations.

## Remaining before unattended operation

Do not schedule this maintenance writer while checkout is open. Continuous sync
needs a tested reservation-aware design covering the gap between Wix checkout
and warehouse allocation, pending/unknown submissions, external stock edits,
stale provider reads and retry recovery. A read/check/write sequence alone is
not a compare-and-swap transaction with checkout.

Validate the actual provider payload and quantity semantics, then verify zero
stock and replenishment on an isolated product, stock persistence in Wix, blocked
checkout at zero, and recovery after failures. Unit tests do not prove those live
behaviors. Missing or ambiguous SKU mappings must be resolved, not guessed.

## API inventory and evidence boundaries

| API/path | Existing integration/use | What still needs end-to-end proof |
| --- | --- | --- |
| `/Json/Public/login/` | Authentication for provider requests | Runtime checks after each environment/deployment change |
| AddOrder (existing `isendService`) | Wix order outbox submission | Customer checkout through allocation, not just a synthetic direct request |
| `/Json/WhseOrder/doQueryOrderPage` | Identity, status and tracking reconciliation | Real allocated order and tracking lifecycle |
| `/Json/InvEntity/doQueryStorageClientInventoryPage` | Fresh inventory source for this preview/apply | Country/SKU/available quantity semantics and live stock reconciliation |
| CancelOrder (local canary script) | Synthetic test cleanup only | Not an automatic Wix cancellation/refund integration |
| `getProductVariants` + `Stores/InventoryItems` | Wix V1 variant identity and quantity reads | Live preview against the published revision |
| `updateInventoryVariantFieldsByProductId` | New gated absolute Wix stock writer | Maintenance baseline, zero-stock checkout and replenishment proof |

See the [Wix stock update contract](https://dev.wix.com/docs/velo/apis/wix-stores-backend/update-inventory-variant-fields-by-product-id)
and [variant lookup contract](https://dev.wix.com/docs/velo/apis/wix-stores-backend/get-product-variants).
