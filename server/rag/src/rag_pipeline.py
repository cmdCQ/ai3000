# AI三千问 - RAG 检索增强生成流水线
# ===================================
# 核心流水线：用户提问 → 向量检索 → 拼入 prompt → LLM 生成

from __future__ import annotations

from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from src.embedder import Embedder
    from src.vector_store import VectorStore


# ── Prompt 模板 ─────────────────────────────────

SYSTEM_PROMPT_TEMPLATE = """你是一位精通中国传统命理学的 AI 助手，名叫"三千问"。
你熟悉以下术数体系：
- 四柱八字（渊海子平、三命通会、滴天髓、子平真诠等）
- 紫微斗数（紫微斗数全书等）
- 梅花易数
- 六爻（卜筮正宗、增删卜易等）
- 奇门遁甲
- 五行基础理论

你的回答要求：
1. **引经据典**：回答时优先引用下方提供的经典原文，注明出处
2. **通俗解释**：在引用古文后，用现代大白话解释含义
3. **保持谦逊**：命理是传统文化智慧，不是绝对科学，用"传统认为""古人认为"等措辞
4. **结构清晰**：分点回答，先说结论，再展开
5. **结合提问者的具体情况**：如果有排盘信息，要结合具体命盘分析

---

以下是知识库中与你问题相关的经典段落，请**优先参考**这些内容作答：

{context}

---

如果下方知识库中没有直接相关的内容，请基于你自身的命理学知识诚实作答，并明确说明"此回答基于通用命理知识，未从古籍中找到直接对应"。"""


USER_PROMPT_TEMPLATE = """用户问题：{question}

{extra_context}"""


# ── RAG 流水线类 ───────────────────────────────

class RAGPipeline:
    """
    检索增强生成流水线

    流程：
    1. 用户问题 → embed_query()
    2. 向量搜索知识库 → top_k 结果
    3. 拼接 context → 构建 prompt
    4. 调用 LLM → 生成答案
    """

    def __init__(
        self,
        embedder: Embedder,
        vector_store: VectorStore,
        llm_client,   # OpenAI-compatible client
        llm_model: str = "qwen3.5-35b-a3b",
        top_k: int = 5,
        similarity_threshold: float = 0.3,
    ):
        self.embedder = embedder
        self.vector_store = vector_store
        self.llm_client = llm_client
        self.llm_model = llm_model
        self.top_k = top_k
        self.similarity_threshold = similarity_threshold

    def retrieve(self, query: str, categories: Optional[list[str]] = None) -> list[dict]:
        """
        检索相关知识
        总是同时搜索指定分类 + 共享库(shared)，确保跨分类引用

        Args:
            query: 用户问题
            categories: 限定分类（可选，None=搜索全部）

        Returns:
            检索结果列表
        """
        query_embedding = self.embedder.embed_query(query)

        # 确定要搜索的分类列表
        if categories is None:
            search_categories = self.vector_store.list_collections()
        else:
            search_categories = list(categories)

        # 总是同时搜索易经/共享库（全类型通用知识库）
        available_collections = self.vector_store.list_collections()
        for shared_cat in ["yijing", "shared"]:
            if shared_cat not in search_categories and shared_cat in available_collections:
                search_categories.append(shared_cat)

        results = self.vector_store.search(
            query_embedding=query_embedding,
            categories=search_categories,
            top_k=self.top_k,
            similarity_threshold=self.similarity_threshold,
        )
        return results

    def build_context(self, results: list[dict]) -> str:
        """将检索结果拼接成 prompt 上下文"""
        if not results:
            return "（未从知识库中找到直接相关内容，请基于通用命理知识作答）"

        context_parts = []
        for i, result in enumerate(results, 1):
            source = f"《{result['book_name']}》"
            if result.get("chapter"):
                source += f" - {result['chapter']}"
            context_parts.append(
                f"【来源 {i}】{source}\n{result['text']}\n"
            )
        return "\n".join(context_parts)

    def build_messages(
        self,
        question: str,
        context: str,
        extra_context: str = "",
        system_prompt: Optional[str] = None,
        history: Optional[list[dict]] = None,
    ) -> list[dict]:
        """构建 LLM 消息列表"""
        sys_prompt = system_prompt or SYSTEM_PROMPT_TEMPLATE.format(context=context)
        user_prompt = USER_PROMPT_TEMPLATE.format(
            question=question,
            extra_context=f"\n补充信息：{extra_context}" if extra_context else "",
        )

        messages = [
            {"role": "system", "content": sys_prompt},
        ]

        # 插入历史对话
        if history:
            messages.extend(history)

        messages.append({"role": "user", "content": user_prompt})
        return messages

    async def ask(
        self,
        question: str,
        category: Optional[str] = None,
        extra_context: str = "",
        system_prompt: Optional[str] = None,
        history: Optional[list[dict]] = None,
    ) -> dict:
        """
        完整 RAG 问答

        Args:
            question: 用户问题
            category: 分类
            extra_context: 额外上下文（如排盘结果）
            system_prompt: 自定义系统提示词
            history: 对话历史

        Returns:
            {"answer": str, "sources": list, "tokens_used": int}
        """
        # 1. 检索
        categories = [category] if category else None
        search_results = self.retrieve(question, categories=categories)

        # 2. 构建上下文
        context = self.build_context(search_results)

        # 3. 构建消息
        messages = self.build_messages(
            question=question,
            context=context,
            extra_context=extra_context,
            system_prompt=system_prompt,
            history=history,
        )

        # 4. 调用 LLM
        response = await self.llm_client.chat.completions.create(
            model=self.llm_model,
            messages=messages,
            max_tokens=2000,
            temperature=0.7,
        )

        answer = response.choices[0].message.content
        tokens_used = response.usage.total_tokens if response.usage else 0

        return {
            "answer": answer,
            "sources": search_results,
            "tokens_used": tokens_used,
        }
