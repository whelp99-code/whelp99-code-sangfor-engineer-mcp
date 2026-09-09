# Local semantic retrieval validation

The services load an immutable Hugging Face commit with `trust_remote_code=False`.
They require the canonical requested model name; the old `local-rapid` alias is no
longer advertised or silently accepted. The TypeScript client rejects a mismatched
model/revision and malformed embedding indexes. No corpus data goes to a cloud model.

Use a Python environment with sentence-transformers, torch (CPU), fastapi and uvicorn.
The locally verified environment versions are recorded with the experiment evidence.
The server is deliberately loopback-only; remote bind is refused by the launcher.

```bash
export SANGFOR_EMBEDDING_SERVER_VENV=/path/to/.venv-embed
export SANGFOR_EMBEDDING_SERVER_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
export SANGFOR_EMBEDDING_MODEL_REVISION=e8f8c211226b894fcb81acc59f3b34ba3efd5f42
export SANGFOR_EMBEDDING_SERVER_PORT=8006
# Optional once model files exist locally:
export HF_HUB_OFFLINE=1
bash automation/embedding-server/start.sh
```

Client / candidate generation (another terminal; the input is never overwritten):

```bash
export SANGFOR_EMBEDDING_PROVIDER=rapid-mlx
export SANGFOR_RAPID_MLX_BASE_URL=http://127.0.0.1:8006/v1
export SANGFOR_RAPID_MLX_EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
export SANGFOR_EMBEDDING_MODEL_REVISION=e8f8c211226b894fcb81acc59f3b34ba3efd5f42
pnpm run rag:reembed /path/to/cleaned.json unused /path/to/new-semantic-candidate.json
```

MiniLM's model default is 128 tokens. Truncation of longer chunks is an explicit
quality limitation of this experiment. The E5 profile uses its existing `query:` /
`passage:` prefixes; never reuse vectors between these model families or revisions.

The default corpus evaluator remains synchronous and performs no external inference.
To exercise actual async retrieval, including optional local reranking:

```bash
export SANGFOR_RAG_EVAL_ASYNC=1
export SANGFOR_MIMO_RERANK_ENABLED=0
export SANGFOR_LOCAL_RERANK_ENABLED=0
# alpha=1: dense only, alpha=0.5: weighted hybrid, alpha=0: lexical scoring.
export SANGFOR_RAG_HYBRID_ALPHA=0.5
# Optional: export SANGFOR_RAG_FUSION=rrf
pnpm --silent run rag:eval:corpus /path/to/new-semantic-candidate.json data/evals/rag/revision-v1-qrels-v2.json
pnpm --silent run rag:eval:corpus /path/to/new-semantic-candidate.json data/evals/rag/revision-v3-validation.json
```

Reports retain actual per-query diagnostics and rerank order fields. A hash fallback
is not semantic success. Different settings generate different settings hashes and
cannot bypass the existing like-for-like quality comparison gate. Compare those
experiments descriptively; the reports never authorize runtime/index promotion.

Optional CrossEncoder service (its model must first be available in the local cache):

```bash
export SANGFOR_EMBEDDING_SERVER_VENV=/path/to/.venv-embed
export SANGFOR_LOCAL_RERANK_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1
export SANGFOR_LOCAL_RERANK_REVISION=1427fd652930e4ba29e8149678df786c240d8825
bash automation/embedding-server/start-reranker.sh
```

Enable only for an explicit experiment in the client process:

```bash
export SANGFOR_LOCAL_RERANK_ENABLED=1
export SANGFOR_LOCAL_RERANK_URL=http://127.0.0.1:8005
export SANGFOR_LOCAL_RERANK_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1
export SANGFOR_LOCAL_RERANK_REVISION=1427fd652930e4ba29e8149678df786c240d8825
export SANGFOR_MIMO_RERANK_TIMEOUT_MS=60000
```

The local adapter refuses remote URLs, redirects, foreign revisions, duplicate/out-of-
range indexes and non-finite scores. Search retains its original order on inference
failure/timeout. Invalid configuration fails closed before inference. By default it ranks one passage per selected source. The explicit experiment
`SANGFOR_LOCAL_RERANK_PASSAGES=2` keeps every selected source, adds at most one extra
passage per source (100 total maximum), ranks all local passages, then deduplicates
to the requested final source count. Local
reranking is disabled by default; it is not automatically better than lexical search.

The reranker admits one inference request per process and refuses overlapping
requests with HTTP 503 and `Retry-After: 1`; it does not queue additional model
work. `/health` exposes `busy` separately from model/configuration identity.
A disconnected or timed-out client does not cancel CPU inference already running:
the slot stays busy until prediction finishes, including its exception path.
This bounds overlap, not the runtime of a single prediction. The client does not
automatically retry or treat a busy/timeout response as evidence of no answer.
Run `pnpm run test:reranker:admission` for the dependency-free concurrency checks.

`SANGFOR_RAG_LEXICAL_PROFILE=stem-ancestors` enables the measured candidate
expansion profile. It uses pinned `stemmer@2.0.1` for plain English tokens of at
least four letters and scores body + 2×leaf heading + ancestor headings, excluding
the document root. Paths, dotted names, switches, versions and Korean tokens are
not stemmed. Original text and embedding vectors remain unchanged. The default
profile is `exact`; an unknown profile is refused. The existing subject prerequisite
still uses exact lexical evidence. This profile improved some development recall
but reduced translated-Korean Hit@5 before reranking, so it is not yet an accepted
deployment configuration. Reported settings identify the selected profile.


### Reproducible scoring configuration

The client factory and service bind model/revision, maximum input length, dtype,
batch size, and optional instruction into `configurationSha256`. Set identical
values on both sides. A missing or different digest refuses scoring; restart an
older service when upgrading this client. The legacy three-argument adapter
constructor remains available for model/revision-only integrations.

Defaults are `SANGFOR_LOCAL_RERANK_MAX_LENGTH=512`,
`SANGFOR_LOCAL_RERANK_DTYPE=auto`, and `SANGFOR_LOCAL_RERANK_BATCH_SIZE=16`.
An optional `SANGFOR_LOCAL_RERANK_INSTRUCTION` must be nonempty and at most 2,048
characters. Maximum input length is 128–4,096, batch size 1–32, and their product
must not exceed 16,384. A context exceeding the model position limit is refused.
`float32` is the supported explicit CPU dtype override; measure it on the target
hardware rather than assuming the checkpoint dtype is fastest.

`LocalRerankProvider.rerankScored()` retains finite raw model scores and verified
candidate IDs. These scores are not calibrated answer probabilities. No score
cutoff or automatic acceptance policy is enabled by this API. The adapter includes
the full title once and strips only its exact duplicate leading heading from the
body before selecting the scoring passage. Persisted source text is unchanged.
