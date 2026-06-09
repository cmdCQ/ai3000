# AI三千问 - FastAPI 后端服务
# ==============================

from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager

import yaml
from fastapi import FastAPI, HTTPException, Query
from openai import AsyncOpenAI

# 确保 src 在 path 中
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.models import (
    IngestRequest,
    IngestResponse,
    RetrieveRequest,
    RetrieveResponse,
    AskRequest,
    AskResponse,
    StoreStats,
    HealthResponse,
)
from src.chunker import TextChunker
from src.embedder import Embedder
from src.vector_store import VectorStore
from src.rag_pipeline import RAGPipeline


# ── 全局状态 ────────────────────────────────────

config: dict = {}
chunker: TextChunker | None = None
embedder: Embedder | None = None
vector_store: VectorStore | None = None
rag_pipeline: RAGPipeline | None = None
llm_client: AsyncOpenAI | None = None


# ── 初始化 ──────────────────────────────────────

def load_config() -> dict:
    """加载配置文件"""
    config_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config.yaml")
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def init_services():
    """初始化所有服务组件"""
    global config, chunker, embedder, vector_store, rag_pipeline, llm_client

    config = load_config()

    # 文本分块器
    chunker = TextChunker(
        chunk_size=config["chunking"]["chunk_size"],
        chunk_overlap=config["chunking"]["chunk_overlap"],
        separators=config["chunking"]["separators"],
    )

    # 向量嵌入器（本地模型优先）
    emb_cfg = config["embedding"]
    llm_cfg = config["llm"]
    embedder = Embedder(
        mode=emb_cfg["mode"],
        model_name=emb_cfg["model_name"],
        dimension=emb_cfg["dimension"],
        api_base=emb_cfg.get("remote_api_base", ""),
        api_key=emb_cfg.get("remote_api_key", ""),
    )

    # 向量存储
    vector_store = VectorStore(
        persist_directory=config["vector_store"]["persist_directory"],
    )

    # LLM 客户端
    llm_config = config["llm"]
    llm_client = AsyncOpenAI(
        api_key=llm_config["api_key"],
        base_url=llm_config["api_base"],
    )

    # RAG 流水线
    rag_pipeline = RAGPipeline(
        embedder=embedder,
        vector_store=vector_store,
        llm_client=llm_client,
        llm_model=llm_config["model"],
        top_k=config["vector_store"]["top_k"],
        similarity_threshold=config["vector_store"]["similarity_threshold"],
    )

    print("[Init] ✨ AI三千问 RAG 后端初始化完成")
    print(f"[Init]   向量模型: {config['embedding']['model_name']}")
    print(f"[Init]   LLM: {config['llm']['model']}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期"""
    print("[Server] 🚀 AI三千问 后端启动中...")
    init_services()
    yield
    print("[Server] 👋 AI三千问 后端关闭")


# ── FastAPI 应用 ────────────────────────────────

app = FastAPI(
    title="AI三千问 - RAG 后端",
    description="命理 AI 知识库检索增强生成服务",
    version="1.0.0",
    lifespan=lifespan,
)


# ═══════════════════════════════════════════════
# API 路由
# ═══════════════════════════════════════════════

# ── 健康检查 ─────────────────────────────────

@app.get("/health", response_model=HealthResponse)
async def health():
    """服务健康检查"""
    return HealthResponse(
        status="ok",
        embedding_model=config["embedding"]["model_name"],
        llm_model=config["llm"]["model"],
    )


# ── 知识入库 ─────────────────────────────────

@app.post("/api/ingest", response_model=IngestResponse)
async def ingest(req: IngestRequest):
    """
    将文档入库到向量知识库

    流程：原始文本 → 分块 → 向量化 → 存储
    """
    if not chunker or not embedder or not vector_store:
        raise HTTPException(status_code=503, detail="服务未初始化")

    try:
        # 1. 分块
        chunks = chunker.chunk_with_metadata(
            text=req.content,
            book_name=req.book_name,
            category=req.category,
            chapter=req.chapter,
        )
        if not chunks:
            return IngestResponse(
                book_name=req.book_name,
                chunks_created=0,
                status="empty_content",
            )

        # 2. 向量化
        texts = [c["text"] for c in chunks]
        embeddings = embedder.embed_documents(texts)

        # 3. 存储
        metadatas = [
            {
                "book_name": c["book_name"],
                "category": c["category"],
                "chapter": c["chapter"],
                "chunk_index": c["chunk_index"],
                **req.metadata,
            }
            for c in chunks
        ]
        vector_store.add_chunks(req.category, texts, embeddings, metadatas)

        return IngestResponse(
            book_name=req.book_name,
            chunks_created=len(chunks),
            status="ok",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"入库失败: {str(e)}")


# ── 知识检索 ─────────────────────────────────

@app.post("/api/retrieve", response_model=RetrieveResponse)
async def retrieve(req: RetrieveRequest):
    """语义检索知识库（只检索，不生成）"""
    if not embedder or not vector_store:
        raise HTTPException(status_code=503, detail="服务未初始化")

    try:
        # 自动包含易经/共享库（全类型通用知识库）
        search_categories = list(req.categories) if req.categories else None
        if search_categories:
            all_cats = vector_store.list_collections()
            for shared_cat in ["yijing", "shared"]:
                if shared_cat not in search_categories and shared_cat in all_cats:
                    search_categories.append(shared_cat)

        query_embedding = embedder.embed_query(req.query)
        results = vector_store.search(
            query_embedding=query_embedding,
            categories=search_categories,
            top_k=req.top_k,
            similarity_threshold=req.similarity_threshold,
        )
        return RetrieveResponse(
            query=req.query,
            results=[{
                "chunk_id": r["chunk_id"],
                "text": r["text"],
                "book_name": r["book_name"],
                "chapter": r["chapter"],
                "category": r["category"],
                "score": r["score"],
                "chunk_index": r["chunk_index"],
            } for r in results],
            total_found=len(results),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"检索失败: {str(e)}")


# ── RAG 问答 ─────────────────────────────────

@app.post("/api/ask", response_model=AskResponse)
async def ask(req: AskRequest):
    """
    完整 RAG 问答：检索 + 生成

    这是核心接口，前端 AI 解析功能直接调用：
    用户问题 → 检索经典 → LLM 参考经典生成答案
    """
    if not rag_pipeline:
        raise HTTPException(status_code=503, detail="RAG 流水线未初始化")

    try:
        result = await rag_pipeline.ask(
            question=req.question,
            category=req.category,
            extra_context=req.extra_context,
            system_prompt=req.system_prompt,
            history=req.history,
        )
        return AskResponse(
            question=req.question,
            answer=result["answer"],
            sources=[{
                "chunk_id": s["chunk_id"],
                "text": s["text"],
                "book_name": s["book_name"],
                "chapter": s["chapter"],
                "category": s["category"],
                "score": s["score"],
                "chunk_index": s["chunk_index"],
            } for s in result["sources"]],
            category=req.category or "all",
            model=config["llm"]["model"],
            tokens_used=result["tokens_used"],
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"问答生成失败: {str(e)}")


# ── 知识库管理 ─────────────────────────────────

@app.get("/api/stats", response_model=StoreStats)
async def get_stats():
    """获取知识库统计信息"""
    if not vector_store or not embedder:
        raise HTTPException(status_code=503, detail="服务未初始化")

    stats = vector_store.get_stats()
    return StoreStats(
        total_chunks=stats["total_chunks"],
        categories=stats["categories"],
        books=stats["books"],
        embedding_model=config["embedding"]["model_name"],
    )


@app.get("/api/categories")
async def list_categories():
    """列出所有可用分类"""
    if not vector_store:
        raise HTTPException(status_code=503, detail="服务未初始化")

    cats = vector_store.list_collections()
    # 合并配置中的描述
    config_cats = {c["slug"]: c for c in config.get("categories", [])}
    return [
        {
            "slug": cat,
            "name": config_cats[cat]["name"] if cat in config_cats else cat,
            "description": config_cats[cat]["description"] if cat in config_cats else "",
            "books": config_cats[cat]["books"] if cat in config_cats else [],
        }
        for cat in cats
    ]


@app.delete("/api/categories/{category}")
async def delete_category(category: str):
    """删除指定分类的所有知识库数据"""
    if not vector_store:
        raise HTTPException(status_code=503, detail="服务未初始化")
    success = vector_store.delete_category(category)
    return {"status": "ok" if success else "failed", "category": category}


@app.post("/api/reset")
async def reset_all():
    """⚠️ 清空所有知识库数据"""
    if not vector_store:
        raise HTTPException(status_code=503, detail="服务未初始化")
    success = vector_store.reset_all()
    return {"status": "ok" if success else "failed"}


# ═══════════════════════════════════════════════
# 启动入口
# ═══════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn

    config = load_config()
    server_cfg = config["server"]
    uvicorn.run(
        "src.main:app",
        host=server_cfg["host"],
        port=server_cfg["port"],
        reload=server_cfg["reload"],
    )
