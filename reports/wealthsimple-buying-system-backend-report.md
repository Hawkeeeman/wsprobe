# MCHP one-cent market buy via Wealthsimple web (MCP)

Date: 2026-05-05  
Method: live browser execution using Chrome DevTools MCP on an already logged-in `my.wealthsimple.com` session.

## Objective

Execute a real `MCHP` buy using **Buy in Dollars** at **$0.01 CAD**, monitor the backend interaction, and map that behavior to `wsli`.

## Executed web flow

1. Opened `MCHP` security details (`sec-s-08e07f72d8d34ed1a255a35ce7d3665d`).
2. Kept side as **Buy** and order type as market.
3. Entered `0.01` in **Dollars**.
4. Selected account **TFSA ($0.02 CAD)**.
5. Clicked **Next**.
6. On review, clicked **Queue order**.

Review screen state before submit:

- Order type: `Fractional buy`
- Estimated quantity: `0.0001 shares`
- Estimated cost: `$0.01 CAD`
- Account: `TFSA`
- Fill note: `Fills on market open`

Immediate post-submit state:

- Status panel showed **Order submitted** with timestamp.
- Activity list updated with a new `Today` item for `MCHP Fractional buy TFSA Rejected`.

## Backend interaction observed (sanitized)

Order flow requests used:

- Host: `https://my.wealthsimple.com`
- Path: `/graphql`
- Method: `POST`

Important header names present:

- `Authorization`
- `x-ws-operation-name`
- `x-ws-profile`
- `x-ws-identity-id`
- `x-ws-api-version`
- `x-ws-page`
- `x-ws-device-id`

Pre-submit validation operations seen:

- `FetchAccountsWithBalance`
- `FetchTradingBalanceBuyingPower`
- `FetchMarketBuffer`
- `FetchSecurityQuoteV2`

Submit mutation:

- Operation: `SoOrdersOrderCreate`
- Input fields:
  - `canonicalAccountId`
  - `externalId` (format `order-<uuid>`)
  - `executionType: FRACTIONAL`
  - `orderType: BUY_VALUE`
  - `value: 0.01`
  - `securityId`
  - `timeInForce: null`

Mutation response:

- `errors: null`
- `order.orderId` returned
- `createdAt` returned

Post-submit status fetch:

- Operation: `FetchSoOrdersExtendedOrder`
- Variables:
  - `branchId: "TR"`
  - `externalId: "order-..."`

## Mapping to `wsli`

`wsli` already follows the same backend contract for dollar buys:

1. Resolve symbol -> `securityId` (`resolveSecurityIdArg`)
2. Build `SoOrdersOrderCreate` input as fractional value buy (`buy` command action)
3. Submit mutation (`graphqlRequest` + `MUTATION_SO_ORDERS_ORDER_CREATE`)
4. Poll `FetchSoOrdersExtendedOrder` by `externalId` (`waitForOrderStatus`)
5. Surface final broker state (`assertBuyOrderNotRejected`)

Equivalent CLI command:

```bash
./wsli buy MCHP --dollars 0.01 --account-id tfsa-u6w4GIXu7Q --confirm
```

## Conclusion

The web app and `wsli` use the same order creation pattern for one-cent dollar buys:

- fractional execution (`FRACTIONAL`)
- value-based order type (`BUY_VALUE`)
- backend status resolution via extended-order polling

For this exact attempt, the backend accepted the create call and then moved the order into a rejected activity state, which indicates the rejection happens after order creation rather than at request validation time.

