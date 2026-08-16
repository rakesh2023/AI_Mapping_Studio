"""Pluggable text embedder for Know Your Data.

Backend selection (first available):
  1. fastembed (BAAI/bge-small-en-v1.5, 384-dim) — real semantic embeddings, no
     API key. Installed on demand; downloads the ONNX model on first use.
  2. Hashing embedder (256-dim, pure numpy) — always available, no dependencies
     beyond numpy. A lexical (bag-of-hashed-tokens) vector: good enough to wire and
     test the pipeline offline; swap in fastembed for real semantic search.

All vectors are L2-normalized, so cosine similarity == dot product. Callers use
embed_texts / embed_query and never care which backend is active.
"""
import hashlib
import re
from typing import List

import numpy as np

try:  # optional semantic backend
    from fastembed import TextEmbedding  # type: ignore
except Exception:  # noqa: BLE001 - absent or import error -> hashing fallback
    TextEmbedding = None

_HASH_DIM = 256
_TOKEN_RE = re.compile(r"[a-z0-9]+")


class _HashingEmbedder:
    name = "hashing-256"
    dim = _HASH_DIM

    def embed(self, texts: List[str]) -> np.ndarray:
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, t in enumerate(texts):
            for tok in _TOKEN_RE.findall((t or "").lower()):
                h = int(hashlib.md5(tok.encode("utf-8")).hexdigest(), 16)
                out[i, h % self.dim] += 1.0 if (h >> 8) & 1 else -1.0
            n = float(np.linalg.norm(out[i]))
            if n:
                out[i] /= n
        return out


class _FastEmbedEmbedder:
    def __init__(self, model_name: str = "BAAI/bge-small-en-v1.5"):
        self._model = TextEmbedding(model_name=model_name)
        self.name = model_name
        self.dim = 384

    def embed(self, texts: List[str]) -> np.ndarray:
        vecs = np.asarray(list(self._model.embed(list(texts))), dtype=np.float32)
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return vecs / norms


_EMBEDDER = None


def get_embedder():
    global _EMBEDDER
    if _EMBEDDER is None:
        if TextEmbedding is not None:
            try:
                _EMBEDDER = _FastEmbedEmbedder()
            except Exception:  # noqa: BLE001 - model load/download failed -> fallback
                _EMBEDDER = _HashingEmbedder()
        else:
            _EMBEDDER = _HashingEmbedder()
    return _EMBEDDER


def embed_texts(texts: List[str]) -> np.ndarray:
    return get_embedder().embed(list(texts))


def embed_query(text: str) -> np.ndarray:
    return get_embedder().embed([text])[0]


def embedder_name() -> str:
    return getattr(get_embedder(), "name", "unknown")


def embedding_dim() -> int:
    return int(getattr(get_embedder(), "dim", _HASH_DIM))
