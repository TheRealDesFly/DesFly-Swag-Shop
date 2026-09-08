# Order and cancellation verification — 2026-09-08

The owner authorized code fixes, testing, and Wix publication, and selected a cancellation request form for customers.

## Candidate checks

- `npm run check`: ESLint, strict inventory TypeScript checking against Wix types, and 646 tests across 28 files passed.
- Wix local preview build completed successfully without forcing past build errors.
- Provider order dates now use `dd/MM/yyyy HH:mm:ss`. The former unpadded date produced HTTP 400; the corrected real-source submission succeeded.
- Order `userId` uses the registered merchant identity independently of the API login. Exact production test-order reads through sections 5.4.2 and 5.4.3 passed.
- Accepted orders without a warehouse number reconcile through read-only lookups. Add is not repeated. Cancellation requires exact `CANCELLED` readback and retires warehouse polling under a mapping lock.
- Lifecycle tests cover duplicate/ambiguous submissions, cancellation races, stale claims, refunds, and physical versus digital fulfillment allocation.
- Final browser checks found that existing checkouts retain old product SKUs. Compatibility is restricted to each of the three verified product identities plus its exact former SKU; modern catalog references must belong to Wix Stores. New catalog SKUs remain canonical.
- The cancellation footer link now appends only the Refund Policy paragraph from Wix's grouped policy text. A real-source check preserved all five original links and verified repeat initialization adds no duplicates.
- Both webhook and poller fulfillment requests exclude explicitly digital lines from mixed orders while preserving every physical allocation.

## Live state verified

- Three Wix hat SKUs were explicitly aligned to the corresponding provider merchant SKUs: white `SKU-604634081598`, black `SKU-604634365452`, and red `SKU-604634105454`.
- Published Wix inventory preview verified quantities 29, 40, and 72 respectively, with no quantity writes. Exact provider filters return one complete row each; the deployed API requires the smaller supported page size of 1,000 despite the PDF's different example.
- The white hat's product-description text field is now optional. Adding it with blank text succeeded, and secure checkout displayed the item and payment flow.
- All nine integration collections exist with Admin-only permissions. New lifecycle fields were provisioned; required existing outbox, claim, lifecycle, and mapping indexes were ACTIVE.
- The customer cancellation form is `147917c5-b39a-4f8a-9e22-c2cbc5cb7f1a`: https://therealdesfly.wixforms.com/f/7503041991672857668 . Required fields reject an empty submission. A clearly labeled synthetic request was stored as CONFIRMED (`2b9117a6-f6e2-40bb-8ebb-6d316314e3ca`), and the public confirmation correctly says cancellation still requires shop approval.
- Requests are reviewed in Wix Forms & Submissions. The shop verifies the customer and eligibility before canceling the Wix order. Refund payment processing remains a separate action.

## Provider test evidence and limits

The local staging configuration was discovered to point to the same effective provider account as production. These runs establish provider behavior, not an isolated staging environment. Runtime and diagnostic guards now reject staging mutations against that shared account.

Both accepted synthetic orders, `WXSTG-mtsjru0l-2f9af6eb` and `WXSTG-mtsjv8xx-7df5fb31`, were independently read back as CANCELLED through both documented detail APIs. The former also resolved to a warehouse identity; the latter was canceled before a warehouse record became visible. The initial HTTP 400 test reference was confirmed absent. The final complete create/cancel run made one Add and one Cancel. No real customer order was canceled or refunded.

A temporary one-unit white-hat reservation cleared on subsequent readback. Final provider physical/available quantities are white 29/29, black 40/40, red 72/72; reserved, allocating, and processing quantities are zero for all three.

No paid checkout was submitted and no shipment was dispatched to establish delivery acceptance. Signed provider webhook registration, full/split parcel allocation evidence, delivery email acceptance, and measured capacity/retention attestations remain separate operational acceptance work. Existing guards continue to reject unsupported fulfillment cases. Publication alone does not prove those workflows.

The final Git revision, Wix publication receipt, and post-publication checks are retained separately in the release execution evidence; this file records the reviewed candidate and completed functional checks.
