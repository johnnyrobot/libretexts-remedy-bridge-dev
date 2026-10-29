# LT-154: vendor questions for atomic CXone content edits

Prepared 2026-10-29 using the Matt Pocock research workflow. This is a question
packet for an authorized operator, not a vendor response or permission to send
one. No message was sent.

## Decision and scope

LibreTexts' integration/deployment team owns obtaining these answers and
arranging separately authorized validation before production automatic-write
enablement. This packet is a handoff requirement, not a request for Johnny to
contact the vendor. The full integration remains delivered in one maintained
build; LibreTexts chooses timing and may select optional review-only rollout.


Keep the [conditional-edit production hold](cxone-conditional-edit-gate.md).
The public sources checked below do not establish an atomic content-POST
precondition that distinguishes every intervening revision. This is an evidence
gap, not a claim that the vendor cannot support such a precondition.

An authorized operator must obtain a current, written vendor contract covering
the exact deployed CXone Expert version and content-edit endpoint. A timestamp
mitigation, a local lock, a fresh read, a hash comparison or a post-write reread
does not establish that contract. Finite successful race trials cannot prove
atomicity. Separately authorized sandbox evidence can exercise a documented
contract and expose violations; it cannot replace the guarantee.

This packet covers full-page content apply and restore through the same content
POST. It does not enable production mutation, change authorization, define a
new request field or authorize a canary, library request or vendor outreach.

## Primary sources checked

All four pages were opened in the mounted Browser tab on **2026-10-29**; visible
navigation results were inspected. The article content was publicly readable
without signing in. These are vendor-owned sources, but the two archived pages
are not evidence of a current supported deployment contract. Page scripts
reported errors while the article content remained readable; no behavior was
tested against an API.

| Source | What was actually established | Limit |
| --- | --- | --- |
| [Current API Reference](https://expert-help.nice.com/Integrations_and_Extending_Content/API) | Its API Calls guide link targets the archived catalog. | The link does not make the archived semantics current. |
| [Current Page resource](https://expert-help.nice.com/Integrations_and_Extending_Content/API/Core_Resources/Page) | Shows page/content revision metadata; its update example uses `edittime=now`. | A response revision is not an accepted expected-revision precondition. |
| [Archived content POST](https://expert-help.nice.com/Internal/Product/Archive/API_Calls/pages/pages_pageid_contents_POST) | Specifies a whole-second `edittime`, with `now` bypassing concurrency checks. Describes `abort=modified` as preventing saves after modification; the default `never` permits overwriting. Lists HTTP 200/400/403/404 and an edit response with success/conflict, base and overwritten revision information. Also describes no-change/overwrite and tidy behavior. | Does not specify atomic revision comparison, timestamp uniqueness, precise aborted-save response, durable completion or lost-response recovery. Conflict information can describe overwritten content, so its presence alone cannot prove rejection. |
| [Archived aggregate page GET](https://expert-help.nice.com/Internal/Product/Archive/API_Calls/pages/pages%2F%2F%7Bpageid%7D_(GET)) | Includes edit timestamps, revision-history links and an example combining a revision with a UTC whole-second timestamp. | Does not guarantee timestamp uniqueness or a content-and-token consistent read. |

Restricted primary-source searches on the same date for content/If-Match,
edittime/modified and atomic/revision returned no additional contract. Search
absence is not proof of non-support. No claim here depends on a secondary
write-up. No publication/update date is inferred from a search crawler date.

## Exact questions the operator must obtain answers to

The following are **questions**, not claims about supported CXone behavior.
Ask the vendor to answer every item explicitly, cite a current specification or
provide a written support guarantee, and identify any unsupported cases.

### 1. Supported endpoint, version and request contract

For our deployed product/version, what exact content POST route supports an
expected-revision precondition? Please specify the request method, canonical
page identity, query/header/body field names, syntax, content type, permissions
and every required option. Which current document supersedes or confirms the
archived reference? Does `/@api/deki/pages/{id}/contents` have the same guarantee
as the `/@api/deki/site/pages/{id}/contents` route shown in the current Page
example? State which route is supported rather than treating them as aliases.

If only timestamp checking is supported, please state that explicitly. If a
revision value, ETag or other opaque token is supported, provide its documented
source and exact use on **content POST**. A property token is insufficient.

### 2. Atomic comparison against every intervening revision

Does the server compare that expected value against the authoritative current
revision and commit the edit as one indivisible operation, with no opportunity
for another writer to commit between comparison and save? Does this hold across
all server instances, interactive editors, API clients and other supported
content-writing paths? If two requests use the same expected revision, can at
most one changing request commit? Describe the serialization/commit guarantee
and its scope; client-side checking or an earlier server read is insufficient.

### 3. Same-timestamp distinguishability and token lifetime

Can two different content revisions have the same accepted `edittime` value?
What precision is stored, returned and accepted, including rounding/truncation,
timezone and comparison rules? Does a stale request based on A reject after B
when A and B share the timestamp accepted by POST? Please explain how every
intervening revision remains distinguishable, including A-to-B-to-A content
changes, restores, imports and failover. Are tokens ever reused or reset? Do
not substitute an unconfirmed fractional timestamp format for a revision token.

### 4. Binding the reviewed content to the precondition

Which supported read returns the exact editable body and its matching expected
revision/token from one consistent state? If separate reads are necessary,
which revision-pinned reads or consistency guarantees let us prove they refer
to the same revision? Can caches, replicas, drafts or rendered/transformed
content expose a body and token from different states? Specify the correct
representation, decoding, revision scope and cache/consistency controls.

### 5. No write on a failed precondition

On a stale expected revision, is the operation guaranteed to leave the current
content and current revision unchanged, with no new content revision or partial
save? Please distinguish any audit/event side effects from a content mutation.
Can conflict handling merge, overwrite, create a page, change its title or
otherwise mutate before reporting a conflict? Which exact options prohibit
those behaviors, and does the guarantee apply to full-body apply and restore?
Explain missing/deleted/renamed/redirected target behavior for numeric page IDs.

### 6. Exact accepted and rejected response schema

Please provide sanitized HTTP status, headers and XML/JSON response examples
for accepted commit, stale rejection, missing target, no-change, invalid
precondition and permission failure. Which fields are required and identify the
canonical target, expected/base revision and actual committed revision? Does
`edit.status=conflict` ever accompany a write? Can HTTP 200 accompany rejection?
What exact response proves no mutation? Do not assume HTTP 409 or 412 applies
unless it is explicitly part of the supported endpoint contract.

### 7. Response versus finalization

At what point is a success response emitted relative to the durable content
commit and revision-history record? Can later processing fail, roll back or
modify the saved content after that response? Are there asynchronous hooks,
tidying/normalization or other transformations that affect exact reviewed
content, the returned revision or the final body? Define no-change semantics,
including whether a new revision is created and what token is then returned.
State when and how an authoritative read can verify the committed revision,
including any documented replication/cache delay.

### 8. Ambiguous dispatch, finality and recovery

After a timeout, connection reset, malformed/truncated response, server error
or caller cancellation, can the request still commit? Is there a supported
request identifier or read-only lookup that binds a particular submitted edit
to its final outcome and committed revision, even if another writer edits
afterwards? How does an operator determine whether a request is terminal or
still executing, and is there a bounded finalization time? Identify which
observations prove rejection versus merely failing to find a revision yet.

If an idempotency mechanism exists, specify its endpoint scope, key lifetime,
body/target binding, concurrent duplicate handling, result replay and behavior
after restart/failover or retention expiry. Do not infer idempotency from a
matching content hash or revision comment. If no definitive reconciliation
facility exists, say so and document the safe support escalation procedure.

### 9. Restore and future changes

Does restoring old reviewed HTML through the same content POST receive exactly
the same precondition and no-write-on-conflict guarantees as apply? Which
platform-native restore operations, if any, have different semantics? Are the
contract and token rules stable across upgrades/configuration changes, and
how are changes communicated so clients can disable writes until revalidated?

## Evidence the operator must return

Record the vendor's dated answer, responsible support reference and applicable
deployment/version, along with a link or retained copy of the current contract.
Record every unanswered question as **unknown**; do not turn an example response
or a successful trial into a guarantee. Obtain exact syntax and documented
outcome examples before designing a new transport implementation.

The automatic-write enablement decision needs a documented atomic precondition that distinguishes
every intervening revision, explicit no-content-write rejection semantics, a
validated response classifier, and a conservative reconciliation plan for
unknown outcomes. Any later sandbox work needs separate approval naming the
exact host, page ID/path, bounded trials and cleanup. The existing gate's
same-timestamp case must be observed, not fabricated; an unobserved collision
remains untested. A stale overwrite fails the gate; passing trials never prove
atomicity. A vendor answer alone does not authorize removing the production hold.

Until separately reviewed recovery is authorized, preserve snapshots,
revision references, dispatch evidence and quarantine. Never automatically
retry an ambiguously dispatched mutation, restore to resolve uncertainty or
restart to bypass a hold. See the local
[signed writer and reconciliation contract](lt-1-signed-writer.md).

## Work performed and limits

Only public documentation navigation/search and local repository document reads
were performed. No CXone library/API request, provider request, credential read,
vendor contact, sandbox trial, live canary, production change or write was made.
No tests were needed for this research note. No source/product files were
changed; this packet does not implement any claimed server semantics.
