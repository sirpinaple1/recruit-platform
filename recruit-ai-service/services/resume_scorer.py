"""简历打分：prompt 组装 + LLM 输出解析与防御性归一。

两种模式共用同一输出 JSON 结构（分数 / 总评 / 维度 / 亮点 / 风险 / 推荐结论），
只是 prompt 与参照物不同：
- match：有需求单 JD，输出「匹配度」
- general：无 JD，输出通用简历分析
"""

import json
import logging
import re

from config.settings import Settings
from services import llm_client

logger = logging.getLogger(__name__)

RECOMMENDATIONS = {"recommend", "maybe", "not_recommend"}
MAX_LIST_ITEMS = 5
MAX_ITEM_CHARS = 200
MAX_SUMMARY_CHARS = 1000

MATCH_SYSTEM_PROMPT = """你是一名资深技术招聘专家。你的任务是：根据职位需求（JD）与候选人简历，对「候选人与该职位的匹配度」打分。

评分要求：
1. score 为 0-100 的整数总分（综合各维度加权，你可以自行判断权重，但技术栈与经验应占主导）。
2. dimensions 依次给出以下 5 个维度的 0-100 分数与一句点评：
   技术栈匹配、经验年限匹配、学历匹配、领域相关性、薪资预期匹配。
3. highlights 列出 2-5 条候选人亮点；risks 列出 0-5 条风险或顾虑（没有则空数组）。
4. recommendation 三选一：recommend（推荐推进面试）/ maybe（待定）/ not_recommend（不推荐）。
5. summary 用 100-200 字给出总体评价，说明最关键的理由。

只输出一个 JSON 对象，不要输出任何其他文字。JSON 结构：
{"score": <int>, "summary": "<str>", "dimensions": [{"name": "<str>", "score": <int>, "comment": "<str>"}], "highlights": ["<str>"], "risks": ["<str>"], "recommendation": "recommend|maybe|not_recommend"}

注意：简历信息可能不完整，缺失的信息在对应维度给中性分（50 左右）并在点评中说明「信息缺失」，不要凭空猜测。"""

GENERAL_SYSTEM_PROMPT = """你是一名资深技术招聘专家。你的任务是：对一份候选人简历做通用分析（当前没有关联的具体职位）。

评分要求：
1. score 为 0-100 的整数，代表该候选人在就业市场上的综合竞争力。
2. dimensions 依次给出以下 5 个维度的 0-100 分数与一句点评：
   技能深度、经验丰富度、教育背景、职业稳定性、市场竞争力。
3. highlights 列出 2-5 条亮点；risks 列出 0-5 条风险或顾虑（没有则空数组）。
4. recommendation 固定输出 "maybe"（通用分析无目标职位，不做推进建议）。
5. summary 用 100-200 字给出总体评价。

只输出一个 JSON 对象，不要输出任何其他文字。JSON 结构：
{"score": <int>, "summary": "<str>", "dimensions": [{"name": "<str>", "score": <int>, "comment": "<str>"}], "highlights": ["<str>"], "risks": ["<str>"], "recommendation": "maybe"}

注意：简历信息可能不完整，缺失的信息在对应维度给中性分（50 左右）并在点评中说明「信息缺失」，不要凭空猜测。"""


class ScoreResult(dict):
    """LLM 打分结果（dict 子类，便于序列化）。"""


def score_resume(settings: Settings, mode: str, resume_text: str,
                 candidate_summary: dict | None, job: dict | None) -> ScoreResult:
    """执行一次打分。

    :param mode: "match"（job 必填）或 "general"
    :param resume_text: Java 侧组装好的简历纯文本
    :param candidate_summary: 候选人摘要（姓名/城市/年限/学历/期望薪资等，不含联系方式）
    :param job: match 模式的需求单信息
    :raises llm_client.LLMError: 调用或解析失败
    """
    if mode not in ("match", "general"):
        raise llm_client.LLMError(f"非法打分模式: {mode}")
    if mode == "match" and not job:
        raise llm_client.LLMError("match 模式必须提供 job")

    system_prompt = MATCH_SYSTEM_PROMPT if mode == "match" else GENERAL_SYSTEM_PROMPT
    user_prompt = _build_user_prompt(mode, resume_text, candidate_summary, job)

    logger.info("开始打分: mode=%s, model=%s, resume_chars=%d",
                mode, settings.llm_model, len(resume_text))
    raw = llm_client.chat(settings, system_prompt, user_prompt)
    result = _parse_and_normalize(raw)
    result["model"] = settings.llm_model
    logger.info("打分完成: mode=%s, score=%s, recommendation=%s",
                mode, result.get("score"), result.get("recommendation"))
    return ScoreResult(result)


def _build_user_prompt(mode: str, resume_text: str,
                       candidate_summary: dict | None, job: dict | None) -> str:
    parts = []
    if mode == "match":
        parts.append("【职位需求】")
        parts.append(_dump(job))
    if candidate_summary:
        parts.append("【候选人基本信息】")
        parts.append(_dump(candidate_summary))
    parts.append("【候选人简历】")
    parts.append(resume_text if resume_text.strip() else "（简历内容为空）")
    return "\n".join(parts)


def _dump(data: dict | None) -> str:
    """dict 序列化为「key: value」行文本（跳过空值），比裸 JSON 更贴近 LLM 阅读习惯。"""
    if not data:
        return "（无）"
    lines = []
    for key, value in data.items():
        if value is None or value == "":
            continue
        if isinstance(value, str):
            value = value.strip()
            if not value:
                continue
        lines.append(f"{key}: {value}")
    return "\n".join(lines) if lines else "（无）"


def _parse_and_normalize(raw: str) -> dict:
    """解析 LLM 输出并做防御性归一：剥 markdown 围栏、clamp 分数、枚举校验、截断。"""
    text = _strip_code_fence(raw)
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        logger.error("LLM 输出不是合法 JSON：%s", text[:300])
        raise llm_client.LLMError(f"LLM 输出无法解析为 JSON: {e}") from e
    if not isinstance(data, dict):
        raise llm_client.LLMError("LLM 输出不是 JSON 对象")

    result = {
        "score": _clamp_int(data.get("score")),
        "summary": _cut_str(data.get("summary"), MAX_SUMMARY_CHARS) or "",
        "dimensions": _normalize_dimensions(data.get("dimensions")),
        "highlights": _normalize_str_list(data.get("highlights")),
        "risks": _normalize_str_list(data.get("risks")),
        "recommendation": _normalize_recommendation(data.get("recommendation")),
    }
    return result


def _strip_code_fence(text: str) -> str:
    """剥掉 ```json ... ``` 围栏（模型偶尔无视 json_object 约束）。"""
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    return m.group(1).strip() if m else text.strip()


def _clamp_int(v, default=0) -> int:
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        return default
    return max(0, min(100, n))


def _cut_str(v, max_chars: int) -> str | None:
    if not isinstance(v, str):
        return None
    v = v.strip()
    return v[:max_chars] if v else None


def _normalize_dimensions(v) -> list[dict]:
    if not isinstance(v, list):
        return []
    out = []
    for item in v:
        if not isinstance(item, dict):
            continue
        name = _cut_str(item.get("name"), 32)
        comment = _cut_str(item.get("comment"), 200)
        if not name:
            continue
        out.append({"name": name, "score": _clamp_int(item.get("score")), "comment": comment or ""})
        if len(out) >= MAX_LIST_ITEMS + 3:  # 维度最多 8 条，防模型刷屏
            break
    return out


def _normalize_str_list(v) -> list[str]:
    if not isinstance(v, list):
        return []
    out = []
    for item in v:
        s = _cut_str(item, MAX_ITEM_CHARS) if isinstance(item, str) else None
        if s:
            out.append(s)
        if len(out) >= MAX_LIST_ITEMS:
            break
    return out


def _normalize_recommendation(v) -> str:
    return v if v in RECOMMENDATIONS else "maybe"
