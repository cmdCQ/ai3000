# AI三千问 - 文本分块器
# ========================
# 将命理古籍拆成适合向量检索的段落

from __future__ import annotations

import re
from typing import Optional

import jieba


class TextChunker:
    """
    中文命理文本智能分块器

    策略：
    1. 按自然段落分隔（双换行）
    2. 按句号/叹号/问号分隔
    3. 保证每块不超过 chunk_size 字符
    4. 块之间保留 overlap 字符重叠
    """

    def __init__(
        self,
        chunk_size: int = 600,
        chunk_overlap: int = 100,
        separators: Optional[list[str]] = None,
    ):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.separators = separators or [
            "\n\n", "\n", "。", "！", "？", "；", "，", " "
        ]

    def chunk(self, text: str) -> list[str]:
        """将文本拆分为块列表"""
        # 1. 预处理：统一换行、去除多余空白
        text = self._preprocess(text)

        # 2. 递归拆分
        chunks = self._split_recursive(text, self.separators)

        # 3. 添加重叠
        chunks = self._add_overlap(chunks)

        # 4. 过滤太短的块（合并到前一/后一块）
        chunks = self._merge_short(chunks, min_length=50)

        return chunks

    def chunk_with_metadata(
        self,
        text: str,
        book_name: str,
        category: str,
        chapter: str = "",
    ) -> list[dict]:
        """拆分文本并附带元数据"""
        chunks = self.chunk(text)
        return [
            {
                "text": chunk,
                "book_name": book_name,
                "category": category,
                "chapter": chapter,
                "chunk_index": idx,
            }
            for idx, chunk in enumerate(chunks)
        ]

    # ── 私有方法 ──────────────────────────────

    def _preprocess(self, text: str) -> str:
        """预处理文本"""
        # 统一换行
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        # 合并多个连续空行
        text = re.sub(r"\n{3,}", "\n\n", text)
        # 去除行首行尾多余空格
        text = "\n".join(line.strip() for line in text.split("\n"))
        # 去除连续空白
        text = re.sub(r"[ 　]{2,}", "", text)
        return text.strip()

    def _split_recursive(self, text: str, separators: list[str]) -> list[str]:
        """递归按分隔符拆分"""
        if len(text) <= self.chunk_size:
            return [text] if text.strip() else []

        # 选第一个分隔符
        sep = separators[0] if separators else " "
        remaining_seps = separators[1:] if len(separators) > 1 else []

        if sep in text:
            parts = text.split(sep)
            chunks = []
            current = ""
            for part in parts:
                candidate = current + (sep if current else "") + part
                if len(candidate) <= self.chunk_size:
                    current = candidate
                else:
                    if current.strip():
                        chunks.append(current)
                    # 如果 part 本身还是太长，继续递归拆分
                    if len(part) > self.chunk_size:
                        sub_chunks = self._split_recursive(part, remaining_seps)
                        chunks.extend(sub_chunks)
                        current = ""
                    else:
                        current = part
            if current.strip():
                chunks.append(current)
            return chunks
        else:
            # 当前分隔符不在文本中，用下一个
            if remaining_seps:
                return self._split_recursive(text, remaining_seps)
            else:
                # 暴力按 chunk_size 切割
                return [text[i : i + self.chunk_size] for i in range(0, len(text), self.chunk_size)]

    def _add_overlap(self, chunks: list[str]) -> list[str]:
        """给相邻块添加重叠内容"""
        if self.chunk_overlap <= 0 or len(chunks) <= 1:
            return chunks

        result = [chunks[0]]
        for i in range(1, len(chunks)):
            prev = chunks[i - 1]
            curr = chunks[i]
            # 从上一块末尾取 overlap 字符
            overlap_text = prev[-self.chunk_overlap:] if len(prev) > self.chunk_overlap else prev
            result.append(overlap_text + curr)

        return result

    def _merge_short(self, chunks: list[str], min_length: int = 50) -> list[str]:
        """合并过短的块到相邻块"""
        if not chunks:
            return chunks

        result = []
        buffer = ""
        for chunk in chunks:
            if len(buffer) + len(chunk) < min_length:
                buffer += chunk
            elif len(chunk) < min_length:
                buffer += chunk
            else:
                if buffer:
                    result.append(buffer)
                    buffer = ""
                result.append(chunk)
        if buffer:
            # 最后一块 buffer 追加到最后一块上
            if result:
                result[-1] += buffer
            else:
                result.append(buffer)
        return result


# ── 便捷函数 ────────────────────────────────────

def chunk_text(
    text: str,
    chunk_size: int = 600,
    chunk_overlap: int = 100,
) -> list[str]:
    """快速分块"""
    chunker = TextChunker(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    return chunker.chunk(text)
