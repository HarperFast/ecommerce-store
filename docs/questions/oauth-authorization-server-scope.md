# Question for the `@harperfast/oauth` maintainers

**Status:** draft, unsent. Auth is outside P0 and this question is not blocking it.

Is the authorization server under `src/lib/mcp/` intended only for MCP client authorization, or can it serve ordinary first-party users? Specifically, can it issue tokens after authenticating against Harper's own credential store, with no upstream identity provider, today or as planned work?

## What we found in v2.6.0

The plugin acts as both:

- A relying party delegating login to GitHub, Google, Azure, Auth0, or Okta (`src/lib/providers/`).
- An experimental, opt-in OAuth 2.1 authorization server (`src/lib/mcp/`), with client registration, authorize/token endpoints, JWKS, discovery, refresh-token and consent stores, and `client_credentials` with `private_key_jwt` for headless agents.

Our reading is that human authentication still goes through an upstream provider. The README describes shared upstream providers and lists transitive revocation as unsupported. Please confirm whether this interpretation is correct.

## Why it matters

The ecommerce benchmark needs a deterministic login path that load generators can exercise. Real upstream logins introduce third-party latency, bot detection, and CAPTCHA; a test-only bypass would exercise a different path from the shipped application.

First-party authentication would also let us compare Harper issuing and validating sessions in-process with a separate identity service such as Supabase Auth, Auth0, or Clerk.

If this is supported or planned, we would like to exercise it in the reference application. If the server is intentionally MCP-only, our proposed auth implementation will use application-level username/password sessions and leave Harper as a storefront identity provider for separate work.
