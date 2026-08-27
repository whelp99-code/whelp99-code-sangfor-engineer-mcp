<!-- Parent: ../../AGENTS.md -->

# jm-browser-agent

> JM-side browser execution agent: an HTTPS **mTLS** listener bound to loopback only
> (task default `https://127.0.0.1:39443`) that BLRO calls to dispatch signed browser jobs.

## The one rule that shapes everything
**JM is never the authority.** BLRO remains canonical for every grant, job, approval and
result. This app therefore:
- never receives a database URL, Prisma client, SQL, or any BLRO database credential;
- **cannot mint anything.** The JM package exports no signer and imports no private-key
  API at all — not even `createPrivateKey`. BLRO-side minting lives in
  `@sangfor/authority` (`signJmAuthorityArtifact`), which no JM source may import. A
  static export-boundary test enforces both halves.
- treats its own response as observational only — a mutation response is never PASS authority.
  Only a distinct receipt/JTI-bound `verify_console` job may return an observational PASS for
  the BLRO oracle to judge; mutation retention remains `indeterminate`.

## Two signed artifacts, deliberately split
| Artifact | Cadence | Role |
|---|---|---|
| `blro-enrollment-grant-snapshot.v1` | startup | Durable identity: tenant/project/installation, device digest, epoch, grants, and the **journal genesis** the refusal journal is bound to. Authorizes no individual job. |
| `blro-authority-receipt.v1` | **per dispatch** | Authorizes exactly one request. Binds all 18 fields: version, receiptId, tenant/project, installation + device digest, origin, authorityEpoch, jobId, requestId, capability JTI, request digest, capability digest, capability verify key **id + digest**, the live **mTLS client fingerprint**, the reservation digest, and issuedAt/expiresAt. |

### Reservation digest
`deriveReservationDigest` lives in the shared L0 contract
(`@sangfor/browser-contracts`). BLRO's signer and JM's verifier each derive it
**independently** from scope + epoch + jobId + requestId + JTI + request digest +
capability digest; JM never copies the expected value out of the receipt it is
checking. `receiptId` is likewise announced out of band
(`x-sangfor-authority-receipt-id`) so neither field can be self-certifying.

Every receipt binding is verified exactly **before** the executor runs. A receipt cannot be
replayed onto another job, request, capability, key, peer, or reservation.

## Durable refusal journal
An append-only, **hash-chained**, `fsync`-durable JSONL journal under `JOURNAL_ROOT`.

**Production NEVER creates it.** The operator pre-initialises the root and the file with
`scripts/jm-journal-init.ts`, which requires a signed grant snapshot plus an explicit
`--apply` and writes through the same durable append. The service only ever *opens* an
established journal and refuses otherwise.
- Primary identity is the **scoped job**: tenant/project/installation/device + `jobId`. The
  stored row additionally binds requestId, JTI, request/capability/reservation digests and
  receiptId. The same job under a brand-new receipt **and** a brand-new JTI is still refused;
  the same JTI across any other job is refused; distinct jobs succeed.
- The reservation is written **before** the executor is called; the post-dispatch
  INDETERMINATE observation is appended after.
- Every append is **TOCTOU-safe**: `lstat` the established file, open with
  `O_WRONLY|O_APPEND|O_NOFOLLOW` (never `'a'`, which implies `O_CREAT`), `fstat` the
  descriptor and require the same device+inode plus regular/0600/owner, write, `fsync`,
  then `lstat` again and require the same device+inode, then `fsync` the directory. A
  journal deleted, replaced, or symlinked at any point refuses and is **never recreated**;
  the executor does not run. Only the operator initialiser may create a file, exclusively.
- Fail closed on: missing root/file (`JOURNAL_NOT_ESTABLISHED`), missing header, empty
  replacement, symlinked root or file, root not `0700`, file not `0600`, wrong owner,
  truncation or hash-chain corruption, a header naming another grant epoch/genesis, and a
  directory `fsync` failure. Readiness and the job route both refuse.

## Real execution preflight — two explicit phases
| Phase | Called | Validates |
|---|---|---|
| `startupPreflight({host, port})` | **exactly once, before the TLS listener exists** | Chromium + profile + execution port, **plus a real bind** of the address the listener is about to take. A bind-probe failure means **no listener is ever created**. |
| `readinessPreflight()` | every `/ready` | Chromium + profile + execution port. Deliberately does **not** rebind the service port, which the running listener already holds. |

There is no hardcoded success. A missing browser or profile after startup yields `/live` 200,
`/ready` 503, job 503 and **executor 0**. The typed fake implements both phases through the
identical seam.

## Real execution only
There is **no mock mode in production**. `SANGFOR_JM_AGENT_EXECUTION_MODE` and every
`*_MOCK*` variant are refused at startup by name. The app constructs the operated
`@sangfor/jm-execution` Playwright port from approved operated config
(`BROWSER_PROFILE_REF`, `BROWSER_SESSION_ID`, `BROWSER_CHROMIUM_PATH`) and enforces
`jobTimeoutMs` through an `AbortSignal`. Tests inject a fake through the **identical** typed
`JmExecutionPort` seam, so no test takes a different runtime path; the fake lives in
`tests/helpers/` and is not importable by the app or the package.

## TLS, origin and rotation
- Startup proves **the CA itself**: every anchor must be a real CA, permitted to sign, and
  within its own validity window. An expired or not-yet-valid CA is refused before the
  listener exists even when the leaf still verifies.
- Startup then proves the server leaf is signed by that CA, carries **serverAuth** EKU, has an
  exact **loopback SAN**, matches its key (SPKI comparison, no private-key API), and is
  currently valid. A clientAuth-only, non-loopback, or foreign leaf is refused before bind.
- Allowed origins canonicalize to an **https origin only** — no path, query, fragment,
  userinfo, or plaintext scheme. The configured BLRO SAN URI is strictly parsed.
- Runtime peer pin checks issuer CN, SAN URI, EKU, serial and fingerprint beyond the CA.
- A **bounded verify key ring**: exactly one `current` key plus at most one `overlap`, each
  with explicit `keyId`/`notBefore`/`notAfter` and a hard `maxOverlapMs`. Unknown, stale,
  future, duplicate or extra keys are refused.

## Routes
| Route | Behavior |
|---|---|
| `GET /live` | **Process-only.** Never consults a dependency or dispatches. |
| `GET /ready` | Dependency-aware: trust, key ring, grant snapshot freshness/revocation, journal health, **real execution preflight**, drain. |
| `POST /v1/browser-jobs` | Strict handler. Refuses **before the executor** on missing/wrong/no client cert, wrong pin, missing/invalid receipt, any binding mismatch, stale/revoked snapshot, unusable key, and duplicate/conflicting dispatch. |

## Lifecycle
Signal handlers for `SIGTERM` and `SIGINT` are **persistent**: they stay installed for the
whole life of the process — through the drain *and after it settles* — and are released only
by the entrypoint immediately before it returns. Removing them on settle was a real defect: a
third signal arriving after a clean drain hit Node's default handler and killed the process
with exit 130. A repeated or mixed signal therefore only ever observes the one memoized drain
promise. A graceful settle closes once and exits **0**; a drain that leaves work outstanding
exits nonzero.

A **stale or revoked but correctly signed** snapshot does *not* fail static startup: the
process comes up, serves TLS `/live`, and reports `/ready` 503 with job refusals and zero
executor calls. `drain()` returns **one shared promise** — double signals, a manual stop, or
a server that never listened are all idempotent. Drain marks draining/unready, refuses new
work, awaits the in-flight event, and on the server-owned positive deadline aborts every
active executor controller and awaits resource/profile close. It marks `closed` only when
everything settled; if an executor ignores its abort the result is a typed **failure** with
state `failed` — never `closed` with work outstanding. Post-dispatch disconnect never retries
and never yields PASS.

## Dependencies
- Depends on: `@sangfor/jm-agent`, `@sangfor/jm-execution`, `@sangfor/browser-contracts`.
- Depended on by: none. BLRO calls it over mTLS, never by import.

## Tests
`tests/jm-browser-agent-runtime.test.ts`, `-tls-integration.test.ts`, `-boundary.test.ts`.

<!-- MANUAL: Notes below this line are preserved on regeneration -->
