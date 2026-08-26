# Capability evidence CLI

The capability evidence CLI is a local evidence-management surface. It never executes a device, enables an execution flag, edits the curated competency catalog, or promotes evidence implicitly.

```bash
node --import tsx scripts/capability-evidence-cli.ts parse --manifest <manifest.json>
node --import tsx scripts/capability-evidence-cli.ts verify --manifest <manifest.json> --evidence-root <root>
node --import tsx scripts/capability-evidence-cli.ts promote --manifest <manifest.json> --promotion <signed-envelope.json> --evidence-root <root>
node --import tsx scripts/capability-evidence-cli.ts stale --manifest <manifest.json> --validation-context <context.json> --evidence-root <root> --promotion-ledger <ledger.jsonl>
node --import tsx scripts/capability-evidence-cli.ts census --json
node --import tsx scripts/capability-evidence-cli.ts campaign scaffold --product HCI --output <existing-task-root>
node --import tsx scripts/capability-evidence-cli.ts --help
node --import tsx scripts/capability-evidence-cli.ts <command> --help
```

Help exits zero and returns JSON with the stable `CAPABILITY_EVIDENCE_HELP` sentinel, command token, and accepted option tokens. `campaign scaffold --help` is equivalent to `campaign --help`.

`stale` recomputes evidence status at the Todo 10 validate-and-persist boundary. There is no caller-provided stale status or reason. It appends only a conservative invalidation when current evidence is genuinely stale; it does not promote.

`census --json` always uses the canonical 20-atom catalog and live tool registry. `data/competency/catalog-manifest.json` binds the complete semantic catalog, sorted atom IDs, and 20/16/4 counts. A missing manifest or any deleted, added, changed, or reclassified atom refuses both census and campaign output. If active evidence authority cannot support replacement metrics, the census lists the atoms and blocked product prerequisites but omits replacement metrics.

Campaign and census wire schemas are structural only and are not exported as authority. Library callers use the context-bound parse/verify functions, which recompute every campaign requirement or census projection from the strictly loaded catalog and manifest.

`campaign scaffold` accepts `HCI`, `IAG`, `EPP`, or `CC`. The output root must already be a real directory, not a symlink. The command creates one new `capability-campaign-<product>.v1.json`, refuses duplicates, and has no overwrite flag. The file contains only requirement and relative evidence paths; credentials, secrets, raw identities, and execution instructions are outside the schema.
