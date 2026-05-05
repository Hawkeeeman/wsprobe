# MCHP Fractional Buy GraphQL Flow Report

Date: 2026-05-05
Method: live Wealthsimple web execution via MCP

## Objective

Run a low-notional dollar buy (`$0.01`) for `MCHP` and document backend order flow used by web and `wsli`.

## Web Execution Summary

- Security: `MCHP` (`sec-s-08e07f72d8d34ed1a255a35ce7d3665d`)
- Ticket mode: market buy in dollars
- Input value: `0.01 CAD`
- Account: `TFSA`
- Review showed fractional semantics (`Fractional buy`, tiny estimated quantity).
- Post-submit activity transitioned to rejected state for this notional.

## Backend GraphQL Logic

Pre-submit checks observed:

- account and buying-power retrieval
- quote retrieval
- market buffer/risk checks

Submit operation:

- `SoOrdersOrderCreate`

Status operation:

- `FetchSoOrdersExtendedOrder` with:
  - `branchId: "TR"`
  - `externalId: "order-<uuid>"`

### Fractional Dollar-Buy Payload Shape

- `canonicalAccountId`
- `securityId`
- `externalId`
- `executionType: "FRACTIONAL"`
- `orderType: "BUY_VALUE"`
- `value: 0.01`
- `timeInForce: null`

## Mapping to `wsli`

`wsli` dollar-buy backend logic matches this contract:

1. resolve symbol -> `securityId`
2. build `BUY_VALUE` + `FRACTIONAL` payload
3. submit `SoOrdersOrderCreate`
4. poll `FetchSoOrdersExtendedOrder`
5. surface terminal broker status

## Conclusion

Dollar buys are accepted through a fractional value-order path. Rejections for very small notionals can occur after order creation, which is why status polling is required.
