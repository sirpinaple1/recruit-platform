"""recruit-ai-service 入口：FastAPI 应用。

本地开发：uvicorn main:app --reload --port 8000
"""

import logging

from fastapi import FastAPI

from config.settings import get_settings
from routers import jd, resume

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)

app = FastAPI(title="recruit-ai-service", version="0.1.0")
app.include_router(resume.router)
app.include_router(jd.router)


@app.get("/health")
async def health():
    settings = get_settings()
    return {
        "status": "ok",
        "model": settings.llm_model,
        # key 只报告「是否配置」，绝不回传内容
        "api_key_configured": bool(settings.llm_api_key),
    }
