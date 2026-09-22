"""简历相关接口。"""

import logging
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from config.settings import get_settings
from services import llm_client, resume_scorer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/resume", tags=["简历"])


class JobInfo(BaseModel):
    """需求单（hr_request）信息，match 模式必填。字段名与 Java 端 camelCase 对齐。"""

    requestId: int = Field(..., gt=0, description="需求单 ID hr_request.id")
    title: str = Field(..., min_length=1, max_length=128, description="岗位名称")
    jobDescription: str | None = Field(None, max_length=8000, description="JD 正文")
    jobRequirement: str | None = Field(None, max_length=8000, description="任职要求")
    salaryMin: int | None = Field(None, ge=0, description="月薪下限（元）")
    salaryMax: int | None = Field(None, ge=0, description="月薪上限（元）")
    education: str | None = Field(None, max_length=32, description="学历要求")
    experienceYears: int | None = Field(None, ge=0, description="要求工作年限")
    location: str | None = Field(None, max_length=128, description="工作地点")


class ResumeScoreRequest(BaseModel):
    resumeId: int = Field(..., gt=0, description="简历版本 ID resume_version.id（透传回显）")
    candidateId: int | None = Field(None, gt=0, description="候选人 ID（透传回显）")
    resumeText: str = Field(..., min_length=1, max_length=60000, description="简历纯文本（Java 侧组装）")
    candidateSummary: dict | None = Field(None, description="候选人摘要（不含联系方式）")
    job: JobInfo | None = Field(None, description="需求单信息；非空=match 模式，空=general 模式")


@router.post("/score")
async def score_resume(request: Request, payload: ResumeScoreRequest):
    """简历打分（同步，超时受 LLM_TIMEOUT_SECONDS 控制）。

    响应符合 docs/conventions/java-python-integration.md §2.2 统一格式。
    """
    start = time.time()
    mode = "match" if payload.job else "general"
    settings = get_settings()
    trace_id = request.headers.get("x-trace-id") or "-"

    logger.info("收到打分请求: trace=%s, mode=%s, resume_id=%s",
                trace_id, mode, payload.resumeId)
    try:
        data = resume_scorer.score_resume(
            settings, mode, payload.resumeText,
            payload.candidateSummary,
            payload.job.model_dump() if payload.job else None,
        )
    except llm_client.LLMError as e:
        logger.error("打分失败: trace=%s, resume_id=%s, duration=%.2fs, error=%s",
                     trace_id, payload.resumeId, time.time() - start, e)
        raise HTTPException(status_code=502, detail=str(e)) from e
    except Exception as e:  # 兜底：不让堆栈泄给调用方
        logger.error("打分异常: trace=%s, resume_id=%s, error=%s",
                     trace_id, payload.resumeId, e, exc_info=True)
        raise HTTPException(status_code=500, detail="服务器内部错误") from e

    data["resume_id"] = payload.resumeId
    data["score_type"] = mode
    logger.info("打分成功: trace=%s, resume_id=%s, mode=%s, score=%s, duration=%.2fs",
                trace_id, payload.resumeId, mode, data.get("score"), time.time() - start)
    return {"code": 200, "message": "success", "data": data}
