"""Opt-in, loopback-only CrossEncoder service. No remote inference or arbitrary model loading."""
import os
import re
import hashlib
import json
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import CrossEncoder

MODEL = os.environ['SANGFOR_LOCAL_RERANK_MODEL']
REVISION = os.environ['SANGFOR_LOCAL_RERANK_REVISION']
if not re.fullmatch(r'[a-f0-9]{40}', REVISION):
    raise RuntimeError('An immutable reranker revision is required')
MAX_LENGTH = int(os.environ.get('SANGFOR_LOCAL_RERANK_MAX_LENGTH', '512'))
BATCH_SIZE = int(os.environ.get('SANGFOR_LOCAL_RERANK_BATCH_SIZE', '16'))
DTYPE = os.environ.get('SANGFOR_LOCAL_RERANK_DTYPE', 'auto')
INSTRUCTION = os.environ.get('SANGFOR_LOCAL_RERANK_INSTRUCTION')
if not 128 <= MAX_LENGTH <= 4096 or not 1 <= BATCH_SIZE <= 32 or MAX_LENGTH * BATCH_SIZE > 16384:
    raise RuntimeError('Invalid bounded reranker context/batch configuration')
if DTYPE not in ('auto', 'float32'):
    raise RuntimeError('Unsupported reranker dtype')
if INSTRUCTION is not None and (not INSTRUCTION.strip() or len(INSTRUCTION) > 2048):
    raise RuntimeError('Invalid reranker instruction')
CONFIGURATION_SHA256 = hashlib.sha256(json.dumps(
    [MODEL, REVISION, MAX_LENGTH, DTYPE, BATCH_SIZE, INSTRUCTION],
    ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
torch.set_num_threads(int(os.environ.get('SANGFOR_EMBEDDING_SERVER_THREADS', '4')))
options = {'model_kwargs': {'dtype': torch.float32}} if DTYPE == 'float32' else {}
if INSTRUCTION is not None:
    options.update(prompts={'grounding': INSTRUCTION}, default_prompt_name='grounding')
model = CrossEncoder(MODEL, revision=REVISION, device='cpu', max_length=MAX_LENGTH, trust_remote_code=False,
                     local_files_only=os.environ.get('HF_HUB_OFFLINE') == '1', **options)
position_limit = getattr(model.model.config, 'max_position_embeddings', None)
if isinstance(position_limit, int) and MAX_LENGTH > position_limit:
    raise RuntimeError('Reranker context exceeds the pinned model position limit')
app = FastAPI(title='sangfor-local-reranker')

class Request(BaseModel):
    model: str
    query: str
    documents: list[str]
    top_n: int

@app.get('/health')
def health():
    return {'ok': True, 'model': MODEL, 'revision': REVISION, 'configurationSha256': CONFIGURATION_SHA256}

@app.post('/rerank')
def rerank(req: Request):
    if req.model != MODEL:
        raise HTTPException(400, 'Requested model does not match the loaded model')
    if not 1 <= len(req.documents) <= 100 or not 1 <= req.top_n <= len(req.documents):
        raise HTTPException(400, 'Invalid candidate count or top_n')
    if len(req.query) > 32000 or any(len(doc) > 32000 for doc in req.documents):
        raise HTTPException(413, 'Input too large')
    scores = model.predict([(req.query, doc) for doc in req.documents], batch_size=BATCH_SIZE, show_progress_bar=False)
    ranked = sorted(enumerate(scores), key=lambda item: (-float(item[1]), item[0]))
    return {'model': MODEL, 'revision': REVISION, 'configurationSha256': CONFIGURATION_SHA256,
            'results': [{'index': index, 'score': float(score)} for index, score in ranked[:req.top_n]]}
