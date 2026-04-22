"""GraphQL query documents for wsprobe (queries only — no mutations)."""

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

FETCH_SECURITY = """
query FetchSecurity($securityId: ID!, $currency: Currency) {
  security(id: $securityId) {
    id
    active
    buyable
    currency
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
