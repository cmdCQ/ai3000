# AI三千问 - 向量存储（ChromaDB）
# =================================

from __future__ import annotations

import uuid
from typing import Optional

import chromadb
from chromadb.config import Settings as ChromaSettings


class VectorStore:
    """
    命理知识库向量存储

    使用 ChromaDB 持久化存储：
    - 每个 category 对应一个 ChromaDB Collection
    - 支持按分类独立检索或跨分类检索
    """

    def __init__(self, persist_directory: str = "./vector_db"):
        self.persist_directory = persist_directory
        self._client: Optional[chromadb.PersistentClient] = None

    @property
    def client(self) -> chromadb.PersistentClient:
        """懒加载客户端"""
        if self._client is None:
            self._client = chromadb.PersistentClient(
                path=self.persist_directory,
                settings=ChromaSettings(anonymized_telemetry=False),
            )
        return self._client

    # ── Collection 管理 ──────────────────────

    def get_collection(self, category: str) -> chromadb.Collection:
        """获取或创建分类对应的 Collection"""
        return self.client.get_or_create_collection(
            name=f"mingli_{category}",
            metadata={"category": category, "description": f"命理知识库 - {category}"},
        )

    def list_collections(self) -> list[str]:
        """列出所有分类"""
        return [c.name.replace("mingli_", "") for c in self.client.list_collections()]

    # ── 写入 ─────────────────────────────────

    def add_chunks(
        self,
        category: str,
        texts: list[str],
        embeddings: list[list[float]],
        metadatas: list[dict],
    ) -> int:
        """
        批量添加文档块到向量库

        Args:
            category: 分类
            texts: 文档块文本
            embeddings: 对应向量
            metadatas: 元数据列表

        Returns:
            添加的块数量
        """
        if not texts:
            return 0

        collection = self.get_collection(category)
        ids = [str(uuid.uuid4()) for _ in texts]

        collection.add(
            ids=ids,
            embeddings=embeddings,
            documents=texts,
            metadatas=metadatas,
        )
        return len(texts)

    # ── 检索 ─────────────────────────────────

    def search(
        self,
        query_embedding: list[float],
        categories: Optional[list[str]] = None,
        top_k: int = 5,
        similarity_threshold: float = 0.3,
    ) -> list[dict]:
        """
        语义搜索知识库

        Args:
            query_embedding: 查询向量
            categories: 限定分类列表，None=搜索全部
            top_k: 返回结果数
            similarity_threshold: 相似度阈值

        Returns:
            检索结果列表 [{chunk_id, text, book_name, chapter, category, score, chunk_index}, ...]
        """
        if categories is None:
            # 搜索全部分类
            categories = self.list_collections()

        all_results = []

        for cat in categories:
            try:
                collection = self.get_collection(cat)
                results = collection.query(
                    query_embeddings=[query_embedding],
                    n_results=top_k,
                    include=["documents", "metadatas", "distances"],
                )

                if results["ids"] and results["ids"][0]:
                    for i, doc_id in enumerate(results["ids"][0]):
                        # ChromaDB 返回 distance（L2距离），转为相似度分数
                        distance = results["distances"][0][i] if results["distances"] else 0
                        score = 1.0 / (1.0 + distance)  # L2距离转相似度

                        if score >= similarity_threshold:
                            metadata = results["metadatas"][0][i] if results["metadatas"] else {}
                            all_results.append({
                                "chunk_id": doc_id,
                                "text": results["documents"][0][i] if results["documents"] else "",
                                "book_name": metadata.get("book_name", ""),
                                "chapter": metadata.get("chapter", ""),
                                "category": cat,
                                "score": round(score, 4),
                                "chunk_index": metadata.get("chunk_index", 0),
                            })
            except Exception as e:
                print(f"[VectorStore] 搜索 {cat} 时出错: {e}")
                continue

        # 按分数降序排序
        all_results.sort(key=lambda x: x["score"], reverse=True)

        return all_results[:top_k]

    # ── 统计 ─────────────────────────────────

    def get_stats(self) -> dict:
        """获取向量库统计信息"""
        stats = {"total_chunks": 0, "categories": {}, "books": {}}
        for cat in self.list_collections():
            try:
                collection = self.get_collection(cat)
                count = collection.count()
                stats["total_chunks"] += count
                stats["categories"][cat] = count

                # 统计各书籍的块数
                if count > 0:
                    all_meta = collection.get(include=["metadatas"])
                    if all_meta["metadatas"]:
                        for meta in all_meta["metadatas"]:
                            book = meta.get("book_name", "未知")
                            stats["books"][book] = stats["books"].get(book, 0) + 1
            except Exception:
                continue
        return stats

    # ── 删除 ─────────────────────────────────

    def delete_category(self, category: str) -> bool:
        """删除指定分类的全部数据"""
        try:
            self.client.delete_collection(f"mingli_{category}")
            return True
        except Exception:
            return False

    def reset_all(self) -> bool:
        """清空所有数据"""
        try:
            self.client.reset()
            return True
        except Exception:
            return False
