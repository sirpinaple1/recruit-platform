"""LLM（OpenAI 兼容）chat/completions 客户端封装，默认 DeepSeek。

一期只做同步 HTTP 调用（httpx），不引入 LangChain —— 打分是单轮结构化任务，
SDK 化收益为零（见 recruit-ai-service/AGENTS.md「实现方案采用简洁方式」）。
"""

import logging

import httpx

from config.settings import Settings

logger = logging.getLogger(__name__)


class LLMError(Exception):
    """LLM 调用失败（网络 / 鉴权 / 上游错误 / 空回复）。"""


def chat(settings: Settings, system_prompt: str, user_prompt: str) -> str:
    """单轮对话，返回模型文本输出。

    :raises LLMError: 任何调用失败场景（统一由上层转 HTTP 状态码）
    """
    if not settings.llm_api_key:
        raise LLMError("缺少 LLM_API_KEY 配置（.env 或环境变量）")

    url = settings.llm_base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": settings.llm_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
        # 结构化打分任务：压低随机性；deepseek-chat / GLM-4 均支持 json_object 输出约束
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": f"Bearer {settings.llm_api_key}"}

    try:
        with httpx.Client(timeout=settings.llm_timeout_seconds) as client:
            resp = client.post(url, json=payload, headers=headers)
    except httpx.TimeoutException as e:
        logger.error("LLM 调用超时：model=%s, timeout=%ss", settings.llm_model, settings.llm_timeout_seconds)
        raise LLMError(f"LLM 调用超时（{settings.llm_timeout_seconds:.0f}s）") from e
    except httpx.HTTPError as e:
        logger.error("LLM 调用网络错误：%s", e)
        raise LLMError(f"LLM 网络错误: {e}") from e

    if resp.status_code != 200:
        # 401 = key 无效；429 = 限流；截断 body 防日志爆炸
        logger.error("LLM 上游错误：status=%s, body=%s", resp.status_code, resp.text[:300])
        raise LLMError(f"LLM 上游返回 {resp.status_code}: {resp.text[:200]}")

    try:
        content = resp.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError) as e:
        logger.error("LLM 响应结构异常：%s", resp.text[:300])
        raise LLMError("LLM 响应结构异常") from e

    if not content or not content.strip():
        raise LLMError("LLM 返回空内容")
    return content.strip()
