#!/usr/bin/env python3
# 优先入库：梅花易数 → 易经 → 其他
# ====================================

import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pymysql
from src.chunker import TextChunker
from src.embedder import Embedder
from src.vector_store import VectorStore
import yaml

# 加载配置
cfg_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.yaml")
with open(cfg_path) as f:
    config = yaml.safe_load(f)

# 初始化
chunker = TextChunker(
    chunk_size=config["chunking"]["chunk_size"],
    chunk_overlap=config["chunking"]["chunk_overlap"],
    separators=config["chunking"]["separators"],
)
emb_cfg = config["embedding"]
embedder = Embedder(
    mode=emb_cfg["mode"],
    model_name=emb_cfg["model_name"],
    dimension=emb_cfg["dimension"],
    api_base=emb_cfg.get("remote_api_base", ""),
    api_key=emb_cfg.get("remote_api_key", ""),
)
vector_store = VectorStore(persist_directory=config["vector_store"]["persist_directory"])

db = pymysql.connect(
    host=os.environ.get("MYSQL_HOST", "localhost"),
    port=int(os.environ.get("MYSQL_PORT", "3306")),
    user=os.environ.get("MYSQL_USER", "root"),
    password=os.environ.get("MYSQL_PASSWORD", ""),
    database=os.environ.get("MYSQL_DATABASE", "ai3000"),
    charset="utf8mb4",
)

def ingest_book(book):
    """入库一本书"""
    cur = db.cursor()
    try:
        content = book[4]  # content field
        if not content:
            return False, "empty"

        chunks = chunker.chunk_with_metadata(text=content, book_name=book[1], category=book[2], chapter="")
        if not chunks:
            return False, "no_chunks"

        texts = [c["text"] for c in chunks]
        embeddings = embedder.embed_documents(texts)
        metadatas = [{ "book_name": c["book_name"], "category": c["category"], "chapter": c["chapter"], "chunk_index": c["chunk_index"] } for c in chunks]
        vector_store.add_chunks(book[2], texts, embeddings, metadatas)

        cur.execute("UPDATE reference_books SET status='ingested', chunks_count=%s, updated_at=%s WHERE id=%s",
                     (len(chunks), int(time.time()*1000), book[0]))
        db.commit()
        return True, len(chunks)
    except Exception as e:
        try:
            cur.execute("UPDATE reference_books SET status='error', updated_at=%s WHERE id=%s",
                         (int(time.time()*1000), book[0]))
            db.commit()
        except: pass
        return False, str(e)[:100]

def run_batch(label, books):
    print(f"\n{'='*50}")
    print(f"📚 {label}: {len(books)} 本")
    print(f"{'='*50}")
    ok, fail = 0, 0
    for i, b in enumerate(books, 1):
        title = b[1]
        size = len(b[4]) if b[4] else 0
        print(f"[{i}/{len(books)}] 📖 {title} ({size//1000}KB)...", end=" ", flush=True)
        t0 = time.time()
        success, info = ingest_book(b)
        dt = time.time() - t0
        if success:
            ok += 1
            print(f"✅ {info} chunks ({dt:.1f}s)")
        else:
            fail += 1
            print(f"❌ {info}")
    print(f"\n{label} 完成: ✅{ok} ❌{fail}")
    return ok, fail

# ═══════════════════════════════════════════
# 阶段 1: 梅花易数（category=meihua, pending）
# ═══════════════════════════════════════════
cur = db.cursor()
cur.execute("SELECT id, title, category, folder, content FROM reference_books WHERE category='meihua' AND status='pending' AND content IS NOT NULL AND content != '' ORDER BY title")
meihua_books = list(cur.fetchall())
ok1, fail1 = run_batch("🌺 梅花易数", meihua_books)

# ═══════════════════════════════════════════
# 阶段 2: 易经（folder=易经 且 status=pending）
# ═══════════════════════════════════════════
cur.execute("SELECT id, title, category, folder, content FROM reference_books WHERE folder='易经' AND status='pending' AND content IS NOT NULL AND content != '' ORDER BY title")
yijing_books = list(cur.fetchall())
ok2, fail2 = run_batch("☯ 易经", yijing_books)

# ═══════════════════════════════════════════
# 阶段 3: 其余全部
# ═══════════════════════════════════════════
cur.execute("SELECT id, title, category, folder, content FROM reference_books WHERE status='pending' AND content IS NOT NULL AND content != '' ORDER BY category, title")
rest_books = list(cur.fetchall())
ok3, fail3 = run_batch("📖 其他分类", rest_books)

print(f"\n🎉 全部完成！总计 ✅{ok1+ok2+ok3} ❌{fail1+fail2+fail3}")
db.close()
