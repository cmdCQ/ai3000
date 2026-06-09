# AI三千问 - 文档入库工具
# =========================
# 用法: python scripts/ingest.py <文件路径> --book "渊海子平" --category "bazi"

from __future__ import annotations

import argparse
import os
import sys

# 将项目根目录加入 path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.chunker import TextChunker
from src.embedder import Embedder
from src.vector_store import VectorStore


def load_config():
    """加载配置文件"""
    import yaml
    config_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.yaml")
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def ingest_file(
    filepath: str,
    book_name: str,
    category: str,
    chapter: str = "",
    chunk_size: int = 600,
    chunk_overlap: int = 100,
):
    """将文件内容入库"""
    # 加载配置
    config = load_config()

    print(f"📖 正在处理: {filepath}")
    print(f"   书名: 《{book_name}》")
    print(f"   分类: {category}")

    # 读取文件
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    print(f"   原始字符数: {len(content)}")

    # 分块
    chunker = TextChunker(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        separators=config["chunking"]["separators"],
    )
    chunks = chunker.chunk_with_metadata(
        text=content,
        book_name=book_name,
        category=category,
        chapter=chapter,
    )
    print(f"   分块数: {len(chunks)}")

    if not chunks:
        print("⚠️ 文本为空，跳过")
        return

    # 向量化
    emb_cfg = config["embedding"]
    embedder = Embedder(
        mode=emb_cfg["mode"],
        model_name=emb_cfg["model_name"],
        dimension=emb_cfg["dimension"],
        api_base=emb_cfg.get("remote_api_base", ""),
        api_key=emb_cfg.get("remote_api_key", ""),
    )
    texts = [c["text"] for c in chunks]
    print(f"🔄 正在向量化 {len(texts)} 个文本块...")
    embeddings = embedder.embed_documents(texts)

    # 存储
    vector_store = VectorStore(persist_directory=config["vector_store"]["persist_directory"])
    metadatas = [
        {
            "book_name": c["book_name"],
            "category": c["category"],
            "chapter": c["chapter"],
            "chunk_index": c["chunk_index"],
        }
        for c in chunks
    ]
    count = vector_store.add_chunks(category, texts, embeddings, metadatas)

    print(f"✅ 入库完成！共 {count} 个文本块")
    print(f"   向量库路径: {config['vector_store']['persist_directory']}")


def ingest_directory(
    dirpath: str,
    book_name: str,
    category: str,
    chunk_size: int = 600,
    chunk_overlap: int = 100,
):
    """将整个文件夹（多个txt文件）作为一个书籍的多个章节入库"""
    config = load_config()

    all_chunks = []
    files = sorted([f for f in os.listdir(dirpath) if f.endswith(".txt")])

    if not files:
        print(f"⚠️ 目录 {dirpath} 中没有 .txt 文件")
        return

    print(f"📚 正在处理目录: {dirpath}")
    print(f"   书名: 《{book_name}》")
    print(f"   分类: {category}")
    print(f"   章节数: {len(files)}")

    chunker = TextChunker(chunk_size=chunk_size, chunk_overlap=chunk_overlap)

    for fname in files:
        fpath = os.path.join(dirpath, fname)
        chapter = os.path.splitext(fname)[0]  # 文件名作为章节名
        with open(fpath, "r", encoding="utf-8") as f:
            content = f.read()
        chunks = chunker.chunk_with_metadata(
            text=content,
            book_name=book_name,
            category=category,
            chapter=chapter,
        )
        all_chunks.extend(chunks)
        print(f"   {chapter}: {len(content)} 字 → {len(chunks)} 块")

    if not all_chunks:
        print("⚠️ 没有有效内容")
        return

    # 向量化 + 存储
    emb_cfg = config["embedding"]
    embedder = Embedder(
        mode=emb_cfg["mode"],
        model_name=emb_cfg["model_name"],
        dimension=emb_cfg["dimension"],
        api_base=emb_cfg.get("remote_api_base", ""),
        api_key=emb_cfg.get("remote_api_key", ""),
    )
    texts = [c["text"] for c in all_chunks]
    print(f"\n🔄 向量化 {len(texts)} 个文本块...")
    embeddings = embedder.embed_documents(texts)

    vector_store = VectorStore(persist_directory=config["vector_store"]["persist_directory"])
    metadatas = [
        {
            "book_name": c["book_name"],
            "category": c["category"],
            "chapter": c["chapter"],
            "chunk_index": c["chunk_index"],
        }
        for c in all_chunks
    ]
    count = vector_store.add_chunks(category, texts, embeddings, metadatas)
    print(f"✅ 入库完成！共 {count} 个文本块")


# ── CLI ─────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="AI三千问 - 知识库文档入库工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 单个文件入库
  python scripts/ingest.py data/books/渊海子平.txt --book "渊海子平" --category bazi

  # 整个目录入库（每个txt作为一个章节）
  python scripts/ingest.py data/books/渊海子平/ --book "渊海子平" --category bazi --dir

  # 指定章节名
  python scripts/ingest.py data/books/渊海子平_卷一.txt --book "渊海子平" --category bazi --chapter "卷一"
        """,
    )
    parser.add_argument("path", help="文件或目录路径")
    parser.add_argument("--book", "-b", required=True, help="书名")
    parser.add_argument("--category", "-c", required=True, help="分类 (bazi/ziwei/meihua/liuyao/qimen/general)")
    parser.add_argument("--chapter", default="", help="章节名（可选）")
    parser.add_argument("--dir", action="store_true", help="以目录模式处理（每个txt是一个章节）")
    parser.add_argument("--chunk-size", type=int, default=600, help="分块大小（字符数，默认600）")
    parser.add_argument("--chunk-overlap", type=int, default=100, help="重叠大小（字符数，默认100）")

    args = parser.parse_args()

    if args.dir:
        ingest_directory(
            args.path, args.book, args.category,
            chunk_size=args.chunk_size,
            chunk_overlap=args.chunk_overlap,
        )
    else:
        ingest_file(
            args.path, args.book, args.category, args.chapter,
            chunk_size=args.chunk_size,
            chunk_overlap=args.chunk_overlap,
        )
