# AI三千问 - 数据模型
# ====================

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# ── 知识库分类 ──────────────────────────────────

class CategorySlug(str, Enum):
    bazi = "bazi"          # 四柱八字
    ziwei = "ziwei"        # 紫微斗数
    meihua = "meihua"      # 梅花易数
    liuyao = "liuyao"      # 六爻
    qimen = "qimen"        # 奇门遁甲
    yijing = "yijing"      # 易经（全类型通用）
    general = "general"    # 通用术数


# ── 文档相关 ────────────────────────────────────

class DocumentChunk(BaseModel):
    """知识库文档片段"""
    chunk_id: str
    text: str
    book_name: str
    category: str          # category slug
    chapter: str = ""
    chunk_index: int = 0
    metadata: dict = Field(default_factory=dict)


class IngestRequest(BaseModel):
    """文档入库请求"""
    book_name: str
    category: str          # category slug
    content: str           # 原始文本内容
    chapter: str = ""      # 章节名
    metadata: dict = Field(default_factory=dict)


class IngestResponse(BaseModel):
    """文档入库响应"""
    book_name: str
    chunks_created: int
    status: str


# ── 检索相关 ────────────────────────────────────

class SearchResult(BaseModel):
    """检索结果单条"""
    chunk_id: str
    text: str
    book_name: str
    chapter: str
    category: str
    score: float
    chunk_index: int


class RetrieveRequest(BaseModel):
    """检索请求"""
    query: str
    top_k: int = 5
    categories: Optional[list[str]] = None   # 限定分类，如 ["bazi", "ziwei"]
    similarity_threshold: float = 0.3


class RetrieveResponse(BaseModel):
    """检索响应"""
    query: str
    results: list[SearchResult]
    total_found: int


# ── RAG 问答 ────────────────────────────────────

class AskRequest(BaseModel):
    """AI 问答请求"""
    question: str
    category: Optional[str] = None   # 命理分类，如 "bazi" / "ziwei" / "meihua"
    top_k: int = 5
    # 额外上下文（如排盘结果）
    extra_context: str = ""
    # 系统提示词覆盖（可选）
    system_prompt: Optional[str] = None
    # 对话历史
    history: list[dict] = Field(default_factory=list)


class AskResponse(BaseModel):
    """AI 问答响应"""
    question: str
    answer: str
    sources: list[SearchResult]     # 引用的知识来源
    category: str
    model: str
    tokens_used: int = 0


# ── 知识库统计 ─────────────────────────────────

class StoreStats(BaseModel):
    """向量库统计"""
    total_chunks: int
    categories: dict[str, int]    # category -> chunk count
    books: dict[str, int]         # book_name -> chunk count
    embedding_model: str


class HealthResponse(BaseModel):
    """健康检查"""
    status: str
    version: str = "1.0.0"
    timestamp: datetime = Field(default_factory=datetime.now)
    embedding_model: str
    llm_model: str
