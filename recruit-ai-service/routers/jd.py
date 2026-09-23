"""JD 生成接口。"""

import logging
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from config.settings import get_settings
from services import jd_generator, llm_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/jd", tags=["JD生成"])


class JdGenerateRequest(BaseModel):
    """岗位要素 + 背景描述。字段名与 Java 端 camelCase 对齐。"""

    title: str = Field(..., min_length=1, max_length=128, description="岗位名称（必填）")
    deptName: str | None = Field(None, max_length=128, description="用人部门")
    salaryMin: int | None = Field(None, ge=0, description="月薪下限（元）")
    salaryMax: int | None = Field(None, ge=0, description="月薪上限（元）")
    location: str | None = Field(None, max_length=128, description="工作地点")
    education: str | None = Field(None, max_length=32, description="学历要求")
    experienceYears: int | None = Field(None, ge=0, description="要求工作年限")
    employmentType: str | None = Field(None, max_length=32, description="用工性质")
    background: str | None = Field(None, max_length=4000, description="HR 补充的背景描述（业务背景/方向偏好）")


@router.post("/generate")
async def generate_jd(request: Request, payload: JdGenerateRequest):
    """一键生成 JD（同步，超时受 LLM_TIMEOUT_SECONDS 控制）。

    响应符合 docs/conventions/java-python-integration.md §2.2 统一格式。
    """
    start = time.time()
    settings = get_settings()
    trace_id = request.headers.get("x-trace-id") or "-"

    logger.info("收到JD生成请求: trace=%s, title=%s", trace_id, payload.title)
    try:
        data = jd_generator.generate_jd(
            settings,
            payload.model_dump(exclude={"background"}),
            payload.background,
        )
    except llm_client.LLMError as e:
        logger.error("JD生成失败: trace=%s, title=%s, duration=%.2fs, error=%s",
                     trace_id, payload.title, time.time() - start, e)
        raise HTTPException(status_code=502, detail=str(e)) from e
    except Exception as e:  # 兜底：不让堆栈泄给调用方
        logger.error("JD生成异常: trace=%s, title=%s, error=%s",
                     trace_id, payload.title, e, exc_info=True)
        raise HTTPException(status_code=500, detail="服务器内部错误") from e

    logger.info("JD生成成功: trace=%s, title=%s, duration=%.2fs",
                trace_id, payload.title, time.time() - start)
    return {"code": 200, "message": "success", "data": data}
