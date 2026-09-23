"""JD 一键生成：prompt 组装 + LLM 输出解析与防御性归一。

与简历打分共用同一套 LLM 客户端（llm_client.chat），但走独立的系统提示词——
打分是「评估」视角，这里是「写作」视角：根据 HR 已填的岗位要素 + 自由补充的
背景描述，产出可直接发布到渠道的 JD 正文与任职要求。
"""

import json
import logging
import re

from config.settings import Settings
from services import llm_client

logger = logging.getLogger(__name__)

MAX_JD_CHARS = 8000

JD_SYSTEM_PROMPT = """你是一名资深技术招聘专家，擅长撰写能吸引目标候选人的职位描述（JD）。

任务：根据给定的岗位要素与背景描述，生成一份可直接发布到招聘渠道的 JD。

要求：
1. jobDescription 为「岗位职责/工作内容」：4-6 个条目，以 1. 2. 3. 编号，每条独占一行、30-60 字；内容必须具体（涉及的技术栈、业务场景、负责的模块），总长度 200-400 字——过于简短的描述可能无法触发招聘平台的职位类型推荐。
2. jobRequirement 为「任职要求」：4-6 个条目，同样编号、每条独占一行、20-50 字；硬性要求（学历/年限/技能）在前，加分项最多 2 条放最后并注明「加分：」。
3. 背景描述里的业务信息应自然融入职责条目；岗位要素与背景描述都未提及的内容不要编造（尤其不要虚构薪资、地点等未提供的字段）。
4. 语言克制专业：不用感叹号、不用「你」称呼读者、不写「关注行业技术动态」「拥抱变化」这类凑数空话；每一条都应是可验证的具体职责或要求。

只输出一个 JSON 对象，不要输出任何其他文字。JSON 结构：
{"jobDescription": "<岗位职责，多行文本>", "jobRequirement": "<任职要求，多行文本>"}"""


class JdResult(dict):
    """LLM 生成的 JD 结果（dict 子类，便于序列化）。"""


def generate_jd(settings: Settings, job: dict, background: str | None) -> JdResult:
    """生成一份 JD。

    :param job: 岗位要素（title/deptName/salaryMin/salaryMax/location/education/
                experienceYears/employmentType，camelCase 对齐 Java 侧）
    :param background: HR 自由补充的背景描述（业务背景、方向偏好等，可为空）
    :raises llm_client.LLMError: 调用失败 / 输出无法解析 / 缺少 JD 正文
    """
    if not isinstance(job, dict) or not str(job.get("title") or "").strip():
        raise llm_client.LLMError("岗位名称（title）必填")

    user_prompt = _build_user_prompt(job, background)
    logger.info("开始生成JD: model=%s, title=%s, background_chars=%s",
                settings.llm_model, job.get("title"),
                len(background) if background else 0)
    raw = llm_client.chat(settings, JD_SYSTEM_PROMPT, user_prompt)
    result = _parse_and_normalize(raw)
    result["model"] = settings.llm_model
    logger.info("JD生成完成: title=%s, jd_chars=%d, req_chars=%d",
                job.get("title"), len(result["jobDescription"]),
                len(result["jobRequirement"]))
    return JdResult(result)


def _build_user_prompt(job: dict, background: str | None) -> str:
    parts = ["【岗位要素】", _dump(job)]
    if background and background.strip():
        parts.append("【背景描述（HR 补充，需融入 JD）】")
        parts.append(background.strip())
    return "\n".join(parts)


def _dump(data: dict | None) -> str:
    """dict 序列化为「key: value」行文本（跳过空值）。"""
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
    """解析 LLM 输出：剥 markdown 围栏、截断超长文本。

    jobDescription 缺失视为失败（它是本次请求的核心产出）；
    jobRequirement 缺失退化为空串（前端可手填，不让整次生成作废）。
    """
    m = re.search(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL)
    text = m.group(1).strip() if m else raw.strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        logger.error("LLM 输出不是合法 JSON：%s", text[:300])
        raise llm_client.LLMError(f"LLM 输出无法解析为 JSON: {e}") from e
    if not isinstance(data, dict):
        raise llm_client.LLMError("LLM 输出不是 JSON 对象")

    job_description = _cut_str(data.get("jobDescription"))
    if not job_description:
        raise llm_client.LLMError("生成结果缺少 JD 正文（jobDescription）")
    return {
        "jobDescription": job_description,
        "jobRequirement": _cut_str(data.get("jobRequirement")) or "",
    }


def _cut_str(v) -> str | None:
    if not isinstance(v, str):
        return None
    v = v.strip()
    return v[:MAX_JD_CHARS] if v else None
