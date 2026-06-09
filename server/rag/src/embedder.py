# AI三千问 - 向量嵌入器（本地优先 / API 备选）
# ================================================
# 默认使用本地 BAAI/bge-small-zh-v1.5 模型（ONNX，免费）
# 也支持远程 OpenAI 兼容 API（如阿里云百炼）

from __future__ import annotations

from typing import Optional


class Embedder:
    """
    中文命理文本向量化

    默认模式：本地 BAAI/bge-small-zh-v1.5（512维，CPU运行）
    备选模式：远程 OpenAI 兼容 API（如 text-embedding-v4，1024维）

    用法:
        embedder = Embedder(mode="local")                   # 本地免费模式
        embedder = Embedder(mode="remote", ...)              # 远程 API 模式
    """

    def __init__(
        self,
        mode: str = "local",
        model_name: str = "BAAI/bge-small-zh-v1.5",
        dimension: int = 512,
        # 远程 API 参数（mode="remote" 时生效）
        api_base: str = "",
        api_key: str = "",
    ):
        self.mode = mode
        self.model_name = model_name
        self.dimension = dimension
        self.api_base = api_base
        self.api_key = api_key

        # 本地模式
        self._local_model = None

        # 远程模式
        self._remote_client = None

    # ── 本地模型（fastembed / ONNX） ──────────────

    def _get_local_model(self):
        """懒加载本地 embedding 模型"""
        if self._local_model is None:
            from fastembed import TextEmbedding

            print(f"[Embedder] 🔄 加载本地模型: {self.model_name} ...")
            self._local_model = TextEmbedding(
                model_name=self.model_name,
                threads=2,          # CPU 线程数
            )
            # 预热：加载后跑一次确保模型就绪
            _ = list(self._local_model.embed(["预热"]))
            print(f"[Embedder] ✅ 本地模型就绪，维度: {self.dimension}")
        return self._local_model

    def _embed_local(self, texts: list[str]) -> list[list[float]]:
        """使用本地模型向量化"""
        import numpy as np
        model = self._get_local_model()
        embeddings = list(model.embed(texts))
        # fastembed 返回 numpy array，转为 Python float 列表
        return [e.tolist() if isinstance(e, np.ndarray) else list(e) for e in embeddings]

    # ── 远程 API（OpenAI 兼容） ──────────────────

    def _get_remote_client(self):
        """懒加载远程 API 客户端"""
        if self._remote_client is None:
            from openai import OpenAI

            self._remote_client = OpenAI(
                api_key=self.api_key,
                base_url=self.api_base,
            )
        return self._remote_client

    def _embed_remote(self, texts: list[str], batch_size: int = 10) -> list[list[float]]:
        """使用远程 API 向量化"""
        client = self._get_remote_client()
        all_embeddings = []

        for i in range(0, len(texts), batch_size):
            batch = texts[i : i + batch_size]
            resp = client.embeddings.create(model=self.model_name, input=batch)
            all_embeddings.extend([d.embedding for d in resp.data])

        return all_embeddings

    # ── 统一接口 ────────────────────────────────

    def embed(self, texts: list[str], batch_size: int = 10) -> list[list[float]]:
        """批量向量化（自动选择本地/远程）"""
        if not texts:
            return []

        if self.mode == "local":
            return self._embed_local(texts)
        else:
            return self._embed_remote(texts, batch_size)

    def embed_query(self, query: str) -> list[float]:
        """单条查询向量化"""
        return self.embed([query])[0]

    def embed_documents(self, texts: list[str], batch_size: int = 10) -> list[list[float]]:
        """文档向量化（同 embed）"""
        return self.embed(texts, batch_size=batch_size)
