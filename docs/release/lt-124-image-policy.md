# Image transport and dependency safety (LT-124)

Availability and AI URL loading share `fetchBoundedImage`. Every initial URL and
redirect must use HTTP(S), have no credentials, pass the optional hostname
allowlist and resolve exclusively to public unicast addresses. URL canonicalization
handles alternate IPv4 notation; ipaddr.js handles mapped IPv6 and nonpublic
ranges. Mixed public/private DNS answers are rejected in their entirety.

The native Node HTTP(S) request uses a lookup callback returning the already
validated address set (including native dual-stack fallback), with no shared agent or second resolver at connect. The URL
hostname remains the request host and HTTPS SNI name; certificate verification
uses Node's default hostname checks. No custom trust bypass or proxy is added.
At most three redirects are followed manually; each hop repeats URL/DNS policy.
No automatic transport retry occurs. HEAD fallback to GET for availability uses
the same budget and redirect count.

One 15-second maximum budget covers DNS, response headers and body, including
redirects and HEAD fallback. Caller cancellation destroys the native request.
The system resolver cannot be forcibly cancelled, but a late DNS answer cannot
start a request. Availability may shorten this deadline. Headers are capped at
16KiB; encoded image bytes at 10MiB, checked before concatenation/decoder entry.
Compressed HTTP representations are explicitly unsupported; requests ask for
identity encoding. Inline image data obeys equivalent byte limits and strict
base64 validation. Unsupported/invalid input requires manual review. Sharp's
40-million input-pixel cap and animated/multipage rejection remain in force.
Direct provider URL inputs are normalized locally instead of delegated blindly.

Denied or failed images remain unresolved findings, become unfixable with an
explicit reason, or return a handler error; a fetch failure never supplies alt
text or decorative intent. The preflight opt-out does not bypass AI fetch policy.
These are per-image bounds; process admission, total request work and decode
cancellation remain LT-113/LT-111 gates.

Tests run real callers/decoding with fake external DNS/HTTP transport. They inspect
connect lookup/SNI options and cover mixed/mapped/private answers, redirects,
rebinding, shared deadlines, late DNS, abort, byte/pixel limits, inline images,
blocked fix evidence and no inference. Native TLS handshake against a live CDN
and final Linux/full-stack behavior are not inferred from these fakes.

## Targeted dependency maintenance

Sharp is pinned at0.35.5; root Axios at1.21.0; ipaddr.js at2.5.0. Lockfile updates
within existing supported ranges include Vite6.4.5, Vitest4.1.12,
concurrently9.2.5, shell-quote1.12.0, source-map-js1.2.2 and follow-redirects1.16.2.
No SDK downgrade or forced audit fix is used.

SDK1.7.0 still embeds Axios1.18.0. The version/layout-guarded postinstall patch
routes both request-instance creation sites in ESM and CommonJS to the pinned
external1.21.0 build, using its explicit fetch adapter to retain SDK behavior.
The import path is computed from the resolved supported Axios entry, so an unused
nested dependency cannot shadow it. The original UTF-8, no-redirect and30s
mutation patch remains. Actual ESM/CommonJS wire tests and request-factory
instrumentation check this route. Clean installs require postinstall; never use
`--ignore-scripts` for a release build.

The lockfile still inventories the SDK's unused Axios1.18 dependency and its
embedded code remains dormant. npm audit still flags the SDK/old Axios chain;
that inventory is reported separately from reachable transport. The locally
routed transport is a compatibility patch, not an upstream SDK security release.
Future SDK changes require reviewing the patch; guards refuse an unknown layout.
Do not describe the whole artifact as advisory-free. Exact final inventories,
CI and review evidence belong in the PR/handoff.
