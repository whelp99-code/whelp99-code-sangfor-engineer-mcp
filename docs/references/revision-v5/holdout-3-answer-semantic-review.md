# Client answer review for frozen holdout 3

This is an implementation-author semantic review, not an independent human or field evaluation. The Codex client read actual stdio MCP hits and authored the saved answers. The server did not generate these answers. Mechanical citation integrity is recorded separately; its `semanticAccuracy` remains null.

All twelve positive answers were checked against the requested scope and captured passage bodies:

| Query | Checked answer requirements |
|---|---|
| 01 | Point-to-point storage allocation exemption; local and iSCSI types. |
| 02 | Generic imported VM NIC, not aNI-specific setup; Compute, More > Edit, eth0, connected device, OK. |
| 03 | Customer self-service not recommended; support involvement and interruption risk; script then precheck package. No command executed. |
| 04 | Central Manager path, task creation, target-device selection, scope and scheduling. |
| 05 | Last 24 hours / Last 7 days; Settings, Asset Location, Src and Domestic/Overseas. |
| 06 | Branch configuration prerequisite; hover description. |
| 07 | Many-to-many resource-pool association; visibility in associated VPC networks. |
| 08 | Datastore Expansion, datastore ID and disk; not cluster expansion or unrelated collection setup. |
| 09 | Unidentified-application audit and UDP 2330; documented adjustment, not a performed policy change. Case version absent and stated as unknown. |
| 10 | Disabled audit policy causes only rejection logs; create/enable audit. Avoid substituting missing-rejection-log cases. Case version unknown. |
| 11 | Object operations stop synchronizing to Managed Cloud Services; abnormal/failed data center use case. |
| 12 | Fulfillment-person reminder restriction; feedback link and completion prerequisite. |

The six current-instance questions explicitly request authorized live observations. The six unsupported-feature questions abstain without inventing configuration instructions or asserting a universal proof of nonexistence.

Query 04 did not retrieve its frozen qrel file `support_21_1093_2637441.md`. Returned `support_21_1093_2637203.md` contains the requested branch-device selection and scheduling procedure for NGFW 8.0.106. This supports the saved answer but does not retroactively alter qrels or the measured 11/12 Hit@5.

The source corpus still contains navigation/footer residue in some captured neighboring passages. Those passages were not used as answer authority. This is a remaining corpus-cleanup opportunity, not evidence that all chrome was eliminated.

Acceptance limits: a single manually authored response per question does not prove repeated client/model reliability. Same-author review cannot establish independent semantic accuracy. Full rollout, operational readiness and broader PR review remain pending.
