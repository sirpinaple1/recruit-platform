"""jd_generator 单测：mock LLM 输出，覆盖解析与边界。"""

import pytest

from config.settings import Settings
from services import jd_generator, llm_client

SETTINGS = Settings(llm_api_key="test-key", llm_model="deepseek-chat")

JOB = {"title": "Java高级工程师", "deptName": "基础平台部", "location": "深圳"}


def _mock_chat(monkeypatch, raw_output):
    monkeypatch.setattr(llm_client, "chat", lambda *a, **k: raw_output)


def test_generate_jd_ok(monkeypatch):
    _mock_chat(monkeypatch, """```json
    {"jobDescription": "1. 负责WMS核心模块开发\\n2. 参与架构设计",
     "jobRequirement": "1. 本科以上\\n2. 加分：有跨境物流经验"}
    ```""")
    result = jd_generator.generate_jd(SETTINGS, JOB, "跨境物流WMS系统")
    assert result["jobDescription"].startswith("1.")
    assert "加分" in result["jobRequirement"]
    assert result["model"] == "deepseek-chat"


def test_generate_jd_no_background(monkeypatch):
    _mock_chat(monkeypatch, '{"jobDescription": "1. 职责", "jobRequirement": "1. 要求"}')
    result = jd_generator.generate_jd(SETTINGS, JOB, None)
    assert result["jobDescription"] == "1. 职责"
    assert result["jobRequirement"] == "1. 要求"


def test_job_requirement_missing_falls_back_empty(monkeypatch):
    _mock_chat(monkeypatch, '{"jobDescription": "1. 职责"}')
    result = jd_generator.generate_jd(SETTINGS, JOB, None)
    assert result["jobRequirement"] == ""


def test_job_description_missing_raises(monkeypatch):
    _mock_chat(monkeypatch, '{"jobRequirement": "1. 要求"}')
    with pytest.raises(llm_client.LLMError):
        jd_generator.generate_jd(SETTINGS, JOB, None)


def test_invalid_json_raises(monkeypatch):
    _mock_chat(monkeypatch, "这不是JSON")
    with pytest.raises(llm_client.LLMError):
        jd_generator.generate_jd(SETTINGS, JOB, None)


def test_empty_title_raises():
    with pytest.raises(llm_client.LLMError):
        jd_generator.generate_jd(SETTINGS, {"title": "  "}, None)
