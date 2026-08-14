"""Local OpenAI-compatible embeddings server for the Sangfor RAG index.

The RAG package talks to any `/v1/embeddings` endpoint (see
`packages/sangfor-rag/src/openai-embeddings-client.ts`); the `rapid-mlx` provider
defaults to `http://127.0.0.1:8000/v1`. On Apple Silicon that endpoint is served by
MLX. This server is the Linux equivalent: the same sentence-transformers model, on CPU.

Two contracts this server MUST hold, or the index silently degrades:

1.  **Model identity.** The index already holds vectors from
    `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (384 dims). Vectors
    from a different model are not comparable, so the model is pinned here and the
    dimension is asserted at startup.
2.  **L2 normalization.** `cosineSimilarity()` in `hash-embedding.ts` is a bare dot
    product — it assumes unit vectors. Un-normalized output would not error anywhere;
    it would just return quietly wrong rankings.

Bound to loopback only, matching the repo's local-authority posture.
"""

from __future__ import annotations

import os
from typing import List, Union

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.environ.get(
    "SANGFOR_EMBEDDING_SERVER_MODEL",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
)
EXPECTED_DIMS = int(os.environ.get("SANGFOR_EMBEDDING_SERVER_DIMS", "384"))
BATCH_SIZE = int(os.environ.get("SANGFOR_EMBEDDING_SERVER_BATCH", "64"))

app = FastAPI(title="sangfor-local-embeddings")
model = SentenceTransformer(MODEL_NAME, device="cpu")

_probe = model.encode(["dimension probe"], normalize_embeddings=True)
if _probe.shape[1] != EXPECTED_DIMS:
    raise RuntimeError(
        f"{MODEL_NAME} produced {_probe.shape[1]} dims, index expects {EXPECTED_DIMS}"
    )


class EmbeddingsRequest(BaseModel):
    input: Union[str, List[str]]
    # Callers send the model they think they are using; we serve the pinned one and
    # echo back what actually produced the vectors so provenance stays honest.
    model: str | None = None
    encoding_format: str | None = None


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": MODEL_NAME, "dimensions": EXPECTED_DIMS}


@app.get("/v1/models")
def list_models() -> dict:
    return {
        "object": "list",
        "data": [
            {"id": MODEL_NAME, "object": "model", "owned_by": "local"},
            # The LiteLLM/CrewAI stack in docs/LOCAL_SETUP.md refers to this route as
            # `local-rapid`; expose the alias so either id resolves here.
            {"id": "local-rapid", "object": "model", "owned_by": "local"},
        ],
    }


@app.post("/v1/embeddings")
def embeddings(req: EmbeddingsRequest) -> dict:
    texts = [req.input] if isinstance(req.input, str) else list(req.input)
    if not texts:
        raise HTTPException(status_code=400, detail="input must not be empty")

    vectors = model.encode(
        texts,
        batch_size=BATCH_SIZE,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    vectors = np.asarray(vectors, dtype=np.float32)

    return {
        "object": "list",
        "model": MODEL_NAME,
        "data": [
            {"object": "embedding", "index": i, "embedding": vectors[i].tolist()}
            for i in range(len(texts))
        ],
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    }
