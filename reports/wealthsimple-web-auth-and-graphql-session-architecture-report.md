# Wealthsimple Web Auth and GraphQL Session Architecture Report

Date: 2026-04-29
Method: live Chrome DevTools MCP inspection on authenticated `my.wealthsimple.com` session

## Scope

Behavioral architecture analysis of web authentication/session lifecycle and GraphQL runtime behavior.

## Authentication/Session Model (Observed)

Hybrid model:

- OAuth bearer token for API authorization
- first-party web session cookie (`_session_id`) for app session continuity

Primary sequence:

1. token grant (`/v1/oauth/v2/token`)
2. token introspection (`/v1/oauth/v2/token/info`)
3. app session bootstrap (`/api/sessions`)
4. continuous authenticated GraphQL traffic (`/graphql`)

## GraphQL Runtime Behavior

Observed characteristics:

- high-frequency `POST /graphql` traffic while authenticated
- consistent identity/session headers (`x-ws-identity-id`, operation headers, profile/version headers)
- immediate cross-tab reuse of active auth/session state
- no interactive relogin required for newly opened tab in same browser context

## Backend Signals and Lifecycle Logic

- `token/info` provides `created_at` + `expires_in` lifecycle visibility.
- observed countdown confirms bounded token lifetime.
- observed created-at progression across timeline indicates silent in-session token rotation.
- frontend storage includes inactivity/session timing keys used by client runtime.

## Security/Transport Controls (Observed)

- bearer authorization on API requests
- `HttpOnly` + `Secure` cookie for app session
- strict security headers and anti-automation/challenge infrastructure

## Conclusion

Wealthsimple web operates a resilient hybrid auth/session architecture with heavy GraphQL-driven runtime sync, token introspection-based lifecycle visibility, and strong same-context cross-tab continuity.
