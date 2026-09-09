"""Opt-in, loopback-only CrossEncoder service. No remote inference or arbitrary model loading."""
import os
import re
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import CrossEncoder

MODEL = os.environ['SANGFOR_LOCAL_RERANK_MODEL']
REVISION = os.environ['SANGFOR_LOCAL_RERANK_REVISION']
if not re.fullmatch(r'[a-f0-9]{40}', REVISION):
    raise RuntimeError('An immutable reranker revision is required')
torch.set_num_threads(int(os.environ.get('SANGFOR_EMBEDDING_SERVER_THREADS', '4')))
model = CrossEncoder(MODEL, revision=REVISION, device='cpu', max_length=512, trust_remote_code=False,
                     local_files_only=os.environ.get('HF_HUB_OFFLINE') == '1')
app = FastAPI(title='sangfor-local-reranker')

class Request(BaseModel):
    model: str
    query: str
    documents: list[str]
    top_n: int

@app.get('/health')
def health():
    return {'ok': True, 'model': MODEL, 'revision': REVISION}

@app.post('/rerank')
def rerank(req: Request):
    if req.model != MODEL:
        raise HTTPException(400, 'Requested model does not match the loaded model')
    if not 1 <= len(req.documents) <= 100 or not 1 <= req.top_n <= len(req.documents):
        raise HTTPException(400, 'Invalid candidate count or top_n')
    if len(req.query) > 32000 or any(len(doc) > 32000 for doc in req.documents):
        raise HTTPException(413, 'Input too large')
    scores = model.predict([(req.query, doc) for doc in req.documents], batch_size=16, show_progress_bar=False)
    ranked = sorted(enumerate(scores), key=lambda item: (-float(item[1]), item[0]))
    return {'model': MODEL, 'revision': REVISION,
            'results': [{'index': index, 'score': float(score)} for index, score in ranked[:req.top_n]]}
