# CEMX Limit Buy GraphQL Implementation Report

Date: 2026-05-05
Method: live browser inspection via `user-chrome-devtools` MCP + `wsli` implementation

## Scope

1. Observe Wealthsimple web limit-buy behavior for CEMX.
2. Map observed behavior to backend GraphQL contract.
3. Implement and validate equivalent CLI support in `wsli`.

## Web Flow Observed (CEMX)

- Symbol: `CEMX` (`sec-s-5cc81ddadfe349c5aa00ef95f548b3b5`)
- Ticket: `Buy -> Limit buy`
- Inputs: `limit price`, `shares`, account (`TFSA`)
- Review semantics:
  - day expiry behavior
  - market-hours trading session
  - explicit limit fill message

## Backend GraphQL Contract Used

Primary operations:

- `FetchSecuritySearchResult`
  - resolve symbol/query -> `securityId`
- `FetchSecurity`
  - validate instrument metadata (`buyable`, `wsTradeEligible`, symbol metadata)
- `SoOrdersOrderCreate` (mutation)
  - submit order intent
- `FetchSoOrdersExtendedOrder`
  - poll lifecycle status by `externalId`
- `FetchSoOrdersLimitOrderRestrictions` (preview-time, best effort)
  - restriction hints; endpoint may return `UNPROCESSABLE_ENTITY` and is non-blocking in preview

### Limit-Buy Mutation Payload Shape

- `canonicalAccountId`
- `securityId`
- `externalId`
- `orderType: "BUY_QUANTITY"`
- `executionType: "LIMIT"`
- `quantity` (whole shares)
- `limitPrice`
- `timeInForce: "DAY"`
- `tradingSession: "REGULAR"`

## Backend Logic Implemented in `wsli`

Order lifecycle logic:

1. Resolve `securityId`.
2. Validate order-mode and numeric constraints.
3. Build mutation payload with `LIMIT` semantics.
4. Submit `SoOrdersOrderCreate`.
5. Handle synchronous mutation errors (`errors[]`) as hard failures.
6. Poll `FetchSoOrdersExtendedOrder` with `externalId`.
7. Return terminal state or structured rejection.

Validation logic:

- enforce allowed order modes
- enforce `--limit-price` for limit mode
- reject incompatible combinations (e.g. market + limit price)
- enforce whole shares for limit buy

## Notes

- Restriction checks remain in preview only and are tolerant of endpoint instability.
- Design favors clean failure for invalid combinations instead of fallback behavior.
