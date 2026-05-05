# CEMX Sell GraphQL Implementation Report

Date: 2026-05-05

## Scope

1. Execute a real CEMX sell via Wealthsimple web.
2. Replace failing REST-based `wsli` sell path with GraphQL order flow.
3. Validate real sell execution from CLI.

## Web Sell Behavior Observed

- Symbol: `CEMX`
- Ticket mode: `Sell -> Limit`
- Inputs: `limit price`, `shares`, account
- Review and submit:
  - explicit limit sell details
  - fill confirmation visible in activity and status panel

## Prior Failure Mode

Old `wsli sell` depended on REST lookup:

- `GET /securities?query=<symbol>`

In this environment it returned `404`, blocking order submission.

## GraphQL Contract Used for Sell

Operations:

- `FetchSecuritySearchResult`
  - resolve symbol -> `securityId`
- `SoOrdersOrderCreate` (mutation)
  - submit sell intent
- `FetchSoOrdersExtendedOrder`
  - poll lifecycle status by `externalId`

### Sell Mutation Payload Shape

- `canonicalAccountId`
- `securityId`
- `externalId`
- `orderType: "SELL_QUANTITY"`
- `executionType: "LIMIT" | "REGULAR" | "FRACTIONAL"`
- `quantity`
- optional `limitPrice`
- `timeInForce: "DAY"` for whole shares
- `tradingSession: "REGULAR"` for limit sells

## Backend Logic Implemented in `wsli`

- unified symbol/security resolution with buy path
- GraphQL submission + status polling pipeline
- structured rejection handling
- order-style validation (`market` vs `limit`)
- support for `--sell-all` (symbol-scoped liquidation only)

## Validation Outcome

CLI execution confirmed successful CEMX sell completion with GraphQL flow and no dependence on failing REST lookup.
