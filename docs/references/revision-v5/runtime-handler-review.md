# Runtime evidence handler delta review

Related issue: #86. Implementation: e65c9c8. Review type: implementation-agent source review, not independent human approval.

The only handler changes in `knowledge-tool-catalog.ts` are (1) not recording a documentation gap when diagnostics require live runtime evidence and (2) including that reason in the existing object-shaped summary response. Raw and vector response shapes, query validation, product/version scope and tool registration remain unchanged. No execution gate or authorization code is changed by this delta.

The stored route review hash was stale. Both CI jobs at 6e2c5c4 failed this same assertion, with 3,331 tests passing and 102 skipped. Update only this handler's reviewed digest and the review document checksum; preserve the origin baseline, route count, all other handler digests, and mutation rejection assertions.

Behavioral coverage: `mcp-search-gaps.test.ts` checks summary reason and no gap persistence for instance facts, plus ordinary missing-document gap persistence; `mcp-rag-search-vectors.test.ts` checks existing output and input contracts; `rag-runtime-evidence-requirement.test.ts` checks procedure/hypothetical preservation and invalid configuration refusal. `mcp-tool-handler-routes.test.ts` retains removed/changed/unexpected route and handler mutant rejection checks.

This fixture maintenance does not change the frozen runtime candidate or its measured retrieval results. Full CI and broader PR review remain separate acceptance requirements.

Verification: the repository test script with appended selectors executed the full configured suite: 430 files passed, 15 skipped; 3,332 tests passed, 102 skipped, 0 failed (46.71s). No tests were disabled for this change.
