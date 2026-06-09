#!/usr/bin/env python3
"""批量入库脚本：将 reference_books 表中所有有内容的书籍分块并导入向量库"""

from __future__ import annotations

import sys
import os
import time
from pathlib import Path

# 将项目根目录加入 sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import pymysql
import yaml

from src.chunker import TextChunker
from src.embedder import Embedder
from src.vector_store import VectorStore

# ── 加载配置 ──────────────────────────────────
config_path = PROJECT_ROOT / "config.yaml"
with open(config_path, "r") as f:
    config = yaml.safe_load(f)

# MySQL 连接配置（优先使用环境变量，否则用默认值）
DB_CONFIG = {
    "host": os.environ.get("MYSQL_HOST", "localhost"),
    "port": int(os.environ.get("MYSQL_PORT", "3306")),
    "user": os.environ.get("MYSQL_USER", "root"),
    "password": os.environ.get("MYSQL_PASSWORD", ""),
    "database": os.environ.get("MYSQL_DATABASE", "ai3000"),
    "charset": "utf8mb4",
}

# 分块配置
chunk_config = config.get("chunking", {})
CHUNK_SIZE = chunk_config.get("chunk_size", 600)
CHUNK_OVERLAP = chunk_config.get("chunk_overlap", 100)

# Embedding 配置
emb_config = config.get("embedding", {})
EMB_MODE = emb_config.get("mode", "local")
EMB_MODEL = emb_config.get("model_name", "BAAI/bge-small-zh-v1.5")
EMB_DIM = emb_config.get("dimension", 512)

# 向量库配置
vs_config = config.get("vector_store", {})
VS_DIR = vs_config.get("persist_directory", "./vector_db")

# 大文件跳过阈值（10MB）
MAX_CONTENT_SIZE = 10 * 1024 * 1024

# Embedding 批处理大小（增大以提高吞吐量）
BATCH_SIZE = 64  # 原配置 8 太慢，CPU 上 64 更高效


def get_db_connection():
    """获取数据库连接"""
    return pymysql.connect(**DB_CONFIG)


def main():
    print("=" * 60)
    print("📚 批量入库：reference_books → 向量库")
    print("=" * 60)
    start_time = time.time()

    # ── 初始化组件 ──────────────────────────
    print(f"\n🔧 初始化分块器 (chunk_size={CHUNK_SIZE}, overlap={CHUNK_OVERLAP})")
    chunker = TextChunker(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)

    print(f"🔧 初始化 Embedder (mode={EMB_MODE}, model={EMB_MODEL})")
    embedder = Embedder(mode=EMB_MODE, model_name=EMB_MODEL, dimension=EMB_DIM)

    print(f"🔧 初始化 VectorStore (persist_dir={VS_DIR})")
    vector_store = VectorStore(persist_directory=str(PROJECT_ROOT / VS_DIR))

    # ── 查询待入库书籍 ─────────────────────
    conn = get_db_connection()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute(
                "SELECT id, title, category, content, author, description "
                "FROM reference_books "
                "WHERE content IS NOT NULL AND content != '' AND status = 'pending' "
                "ORDER BY id ASC"
            )
            books = cursor.fetchall()
    finally:
        conn.close()

    total = len(books)
    print(f"\n📖 待入库书籍: {total} 本")

    if total == 0:
        print("✅ 没有待入库的书籍，任务结束。")
        return

    # ── 统计 ────────────────────────────────
    success_count = 0
    fail_count = 0
    skip_count = 0
    total_chunks = 0
    failed_books = []

    # ── 逐本处理 ───────────────────────────
    for idx, book in enumerate(books, 1):
        book_id = book["id"]
        title = book["title"]
        category = book.get("category", "general")
        content = book.get("content", "")

        print(f"\n{'─' * 50}")
        print(f"[{idx}/{total}] 📖 正在入库《{title}》(ID={book_id}, 分类={category})")

        # 检查内容大小
        content_len = len(content)
        print(f"  内容大小: {content_len:,} 字符 ({content_len / 1024:.1f} KB)")

        if content_len > MAX_CONTENT_SIZE:
            print(f"  ⚠️ 内容过大 ({content_len / 1024 / 1024:.1f} MB), 跳过")
            conn = get_db_connection()
            try:
                with conn.cursor() as cursor:
                    cursor.execute(
                        "UPDATE reference_books SET status='error' WHERE id=%s",
                        (book_id,),
                    )
                conn.commit()
            finally:
                conn.close()
            skip_count += 1
            failed_books.append(f"《{title}》: 文件过大 ({content_len / 1024 / 1024:.1f} MB)")
            continue

        try:
            # 1. 分块
            chunk_start = time.time()
            chunks = chunker.chunk_with_metadata(
                text=content,
                book_name=title,
                category=category,
            )
            chunk_time = time.time() - chunk_start
            print(f"  📦 分块完成: {len(chunks)} 块 (耗时 {chunk_time:.1f}s)")

            if not chunks:
                print("  ⚠️ 无有效内容块，标记为空")
                conn = get_db_connection()
                try:
                    with conn.cursor() as cursor:
                        cursor.execute(
                            "UPDATE reference_books SET status='empty' WHERE id=%s",
                            (book_id,),
                        )
                    conn.commit()
                finally:
                    conn.close()
                skip_count += 1
                continue

            # 2. 提取文本和元数据
            texts = [c["text"] for c in chunks]
            metadatas = [
                {
                    "book_name": c["book_name"],
                    "category": c["category"],
                    "chapter": c.get("chapter", ""),
                    "chunk_index": c["chunk_index"],
                }
                for c in chunks
            ]

            # 3. 批量向量化（分批处理，避免内存爆）
            embed_start = time.time()
            all_embeddings = []
            total_batches = (len(texts) + BATCH_SIZE - 1) // BATCH_SIZE
            for bi, i in enumerate(range(0, len(texts), BATCH_SIZE)):
                batch = texts[i : i + BATCH_SIZE]
                embs = embedder.embed(batch)
                all_embeddings.extend(embs)
                # 每 10 个批次或最后一批打印进度
                if (bi + 1) % 10 == 0 or (i + BATCH_SIZE) >= len(texts):
                    done = min(i + BATCH_SIZE, len(texts))
                    print(f"  🔄 向量化: {done}/{len(texts)} ({bi+1}/{total_batches} 批次)")
            embed_time = time.time() - embed_start
            print(f"  🧬 向量化完成: {len(all_embeddings)} 条 (耗时 {embed_time:.1f}s)")

            # 4. 存入向量库
            store_start = time.time()
            vector_store.add_chunks(
                category=category,
                texts=texts,
                embeddings=all_embeddings,
                metadatas=metadatas,
            )
            store_time = time.time() - store_start
            print(f"  💾 向量库写入完成 (耗时 {store_time:.1f}s)")

            # 5. 更新数据库状态
            conn = get_db_connection()
            try:
                with conn.cursor() as cursor:
                    cursor.execute(
                        "UPDATE reference_books SET status='ingested', chunks_count=%s WHERE id=%s",
                        (len(chunks), book_id),
                    )
                conn.commit()
            finally:
                conn.close()

            total_time = chunk_time + embed_time + store_time
            success_count += 1
            total_chunks += len(chunks)
            print(f"  ✅ 《{title}》入库完成，{len(chunks)} 个文本块 (总耗时 {total_time:.1f}s)")

        except Exception as e:
            print(f"  ❌ 入库失败: {e}")
            # 标记为 error
            conn = get_db_connection()
            try:
                with conn.cursor() as cursor:
                    cursor.execute(
                        "UPDATE reference_books SET status='error' WHERE id=%s",
                        (book_id,),
                    )
                conn.commit()
            finally:
                conn.close()
            fail_count += 1
            failed_books.append(f"《{title}》: {str(e)[:100]}")

    # ── 最终统计 ────────────────────────────
    elapsed = time.time() - start_time
    print("\n" + "=" * 60)
    print("📊 批量入库完成")
    print("=" * 60)
    print(f"  成功入库: {success_count} 本")
    print(f"  失败:     {fail_count} 本")
    if skip_count:
        print(f"  跳过:     {skip_count} 本")
    print(f"  总文本块: {total_chunks}")
    print(f"  总耗时:   {elapsed:.1f}s ({elapsed / 60:.1f} min)")
    print("=" * 60)

    if failed_books:
        print("\n❌ 失败详情:")
        for fb in failed_books:
            print(f"  - {fb}")

    # 打印向量库统计
    print("\n📊 向量库当前统计:")
    stats = vector_store.get_stats()
    print(f"  总块数: {stats['total_chunks']}")
    for cat, count in stats.get("categories", {}).items():
        print(f"    {cat}: {count} 块")


if __name__ == "__main__":
    main()
