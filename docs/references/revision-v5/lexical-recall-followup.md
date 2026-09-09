# Lexical recall diagnosis after the rejected candidate

Tracking: #86. Base: `5b3fe20`. This is development evidence, not final acceptance.

Before changing ranking, check three alternative explanations: absent source,
incorrect product/version filtering, and lexical mismatch. Both missed sources
exist in the structured corpus with the requested product/version. Their BM25
ranks among distinct authorized sources are 427/749 (NGFW) and 239/781 (SCP).
An isolated query word-form substitution raises them to 25 and 9 respectively.
See `lexical-recall-diagnosis.json`; the altered diagnostic queries are not shipped
query rewrites, and labels/canonical fixtures remain unchanged.

The search view removes the full heading from the body and scores only the last
breadcrumb. Consequently `Upgrade Impacts`, a meaningful ancestor of `Impacts on
Services`, contributes no lexical evidence. This is a separate hypothesis to test
with a bounded ancestor-heading field; do not restore duplicated product boilerplate
or add query/source-specific boosts.

A confirmed tokenizer defect also treats sentence-final plain words as different
terms (`quorum.` versus `quorum`). The implementation now removes a single final
period only from plain alphabetic/Korean words before stop-word/plural handling.
Paths, switches, numeric versions and internally dotted identifiers remain intact.
A single-label absolute DNS name such as `host.` is lexically normalized to `host`;
this is a search view, never a modification of source text or an execution target.

Validation: 45 tests passed across rag-hybrid-search, rag-retrieval-v3 and
rag-semantic-runtime-v4; `pnpm run lint` passed. Corpus evaluation is explicitly
BM25 with subject gating enabled and no reranking. Development hit counts remain
20/21, 12/12 and 11/12; each has zero no-answer false positives. Original-set MRR
improves from 0.718254 to 0.742063. The exposed failed client evaluation remains
10/12 with 6/12 no-answer false positives. See `punctuation-development-results.json`.

Next: evaluate conservative word-form normalization and ancestor-heading evidence
across all development positives and negatives, then measure a fixed evidence-aware
reranker. Neither extra lexical matches nor high raw reranker scores prove an
answer exists. A newly frozen evaluation set and actual answer/citation verification
are still required before merging or activating the candidate on BLRO. The existing
failed holdout results remain authoritative evidence of rejection. LightRAG remains
excluded.
