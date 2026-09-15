# Question for the `@harperfast/oauth` maintainers

**Context:** the `ecommerce-store` golden reference needs an identity story that (a) bots can
drive deterministically for benchmarking and (b) gives the Harper-vs-Supabase/Auth0/Clerk
comparison something architecturally real to measure.

---

`@harperfast/oauth` v2.6.0 does two distinct things: it is a **relying party** that
delegates login to GitHub/Google/Azure/Auth0/Okta (`src/lib/providers/`), and — under
`src/lib/mcp/`, marked experimental and opt-in — it is a full **OAuth 2.1 authorization
server** that issues its own tokens, with dynamic client registration, authorize/token
endpoints, JWKS, `.well-known` discovery, refresh-token and consent stores, and a
`client_credentials` + `private_key_jwt` path for headless agents. Reading it, the AS looks
*federated by design*: for any human user it still sends the person upstream to a configured
provider to actually authenticate (the README describes MCP clients authenticating "against
the same upstream providers", and "Not yet supported" lists transitive revocation as a
consequence of the upstream session model), so Harper mints the token but is not itself the
place a password is checked. That distinction decides two things for us. First, whether we
can benchmark it at all: if every human login round-trips to Google or GitHub, our load
generators hit real bot-detection and CAPTCHA, and the only way to measure a login path is a
test-only bypass — which means the path we ship is not the path we test, and a golden
reference cannot have that property. Second, whether there is a genuinely comparable
Harper-native story: "Harper issues and validates session tokens in-process" versus
"Supabase Auth / Auth0 / Clerk as a separate tier" is a strong, honest comparison, but only
if Harper can authenticate a first-party end user against its own user store rather than
brokering someone else's. **So, concretely: is the authorization server under `src/lib/mcp/`
deliberately scoped to MCP client authorization only, or is it a general-purpose OAuth 2.1
AS that happens to live under that namespace — and in particular, can it (today, or as
intended future work) issue tokens for ordinary first-party end users who authenticate
against Harper's own credential store with no upstream IdP in the loop? If that is possible
or planned, we would like to exercise it in the ecommerce reference as the Harper-native
identity story and measure it; if it is deliberately MCP-only, we will ship v1 on
application-level username/password sessions and treat "Harper as a storefront IdP" as a
separate piece of work rather than assuming it exists.**
