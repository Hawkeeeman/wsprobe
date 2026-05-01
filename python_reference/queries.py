"""GraphQL documents for wsprobe."""

FETCH_IDENTITY_PACKAGES = """
query FetchIdentityPackages($id: ID!) {
  identity(id: $id) {
    id
    packages {
      id
      __typename
    }
    __typename
  }
}
"""

FETCH_TRADE_ACCOUNT_LIST = """
query FetchTradeAccountList($identityId: ID!, $pageSize: Int = 50, $cursor: String) {
  identity(id: $identityId) {
    id
    accounts(filter: {}, first: $pageSize, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
        __typename
      }
      edges {
        node {
          id
          status
          unifiedAccountType
          nickname
          currency
          custodianAccounts {
            id
            branch
            status
            financials {
              current {
                netLiquidationValue {
                  amount
                  currency
                  __typename
                }
                __typename
              }
              __typename
            }
            __typename
          }
          financials {
            currentCombined {
              netLiquidationValue {
                amount
                currency
                __typename
              }
              netDeposits {
                amount
                currency
                __typename
              }
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}
"""

FETCH_SECURITY = """
query FetchSecurity($securityId: ID!) {
  security(id: $securityId) {
    id
    active
    buyable
    wsTradeEligible
    wsTradeIneligibilityReason
    status
    securityType
    stock {
      symbol
      name
      primaryExchange
      primaryMic
      __typename
    }
    __typename
  }
}
"""

FETCH_SECURITY_QUOTES = """
query FetchIntraDayChartQuotes(
  $id: ID!
  $date: Date
  $tradingSession: TradingSession
  $currency: Currency
  $period: ChartPeriod
) {
  security(id: $id) {
    id
    chartBarQuotes(
      date: $date
      tradingSession: $tradingSession
      currency: $currency
      period: $period
    ) {
      securityId
      price
      sessionPrice
      timestamp
      currency
      marketStatus
      __typename
    }
    __typename
  }
}
"""

FETCH_SO_ORDERS_LIMIT_ORDER_RESTRICTIONS = """
query FetchSoOrdersLimitOrderRestrictions($args: SoOrders_LimitOrderRestrictionsArgs!) {
  soOrdersLimitOrderRestrictions(args: $args) {
    limitPriceThresholds
    __typename
  }
}
"""

FETCH_SECURITY_SEARCH = """
query FetchSecuritySearchResult($query: String!) {
  securitySearch(input: {query: $query}) {
    results {
      id
      buyable
      status
      stock {
        symbol
        name
        primaryExchange
        __typename
      }
      __typename
    }
    __typename
  }
}
"""

MUTATION_SO_ORDERS_ORDER_CREATE = """
mutation SoOrdersOrderCreate($input: SoOrders_CreateOrderInput!) {
  soOrdersCreateOrder(input: $input) {
    errors {
      code
      message
      __typename
    }
    order {
      orderId
      createdAt
      __typename
    }
    __typename
  }
}
"""

FETCH_SO_ORDERS_EXTENDED_ORDER = """
query FetchSoOrdersExtendedOrder($branchId: String!, $externalId: String!) {
  soOrdersExtendedOrder(branchId: $branchId, externalId: $externalId) {
    averageFilledPrice
    filledExchangeRate
    filledQuantity
    filledCommissionFee
    filledTotalFee
    firstFilledAtUtc
    lastFilledAtUtc
    limitPrice
    openClose
    orderType
    optionMultiplier
    rejectionCause
    rejectionCode
    securityCurrency
    status
    stopPrice
    submittedAtUtc
    submittedExchangeRate
    submittedNetValue
    submittedQuantity
    submittedTotalFee
    timeInForce
    accountId
    canonicalAccountId
    cancellationCutoff
    tradingSession
    expiredAtUtc
    securityId
    __typename
  }
}
"""
