"""resume_scorer 单测：mock LLM 输出，覆盖解析归一的各种边界。"""

import pytest

from config.settings import Settings
from services import llm_client, resume_scorer

SETTINGS = Settings(llm_api_key="test-key", llm_model="deepseek-chat")


def _mock_chat(monkeypatch, raw_output):
    monkeypatch.setattr(llm_client, "chat", lambda *a, **k: raw_output)


def test_score_resume_match_ok(monkeypatch):
    _mock_chat(monkeypatch, """```json
    {"score": 82, "summary": "候选人五年Java后端经验，技术栈与JD高度重合。",
     "dimensions": [{"name": "技术栈匹配", "score": 90, "comment": "Spring/MySQL均具备"}],
     "highlights": ["大型系统架构经验"], "risks": ["薪资预期接近上限"],
     "recommendation": "recommend"}
    ```""")
    result = resume_scorer.score_resume(
        SETTINGS, "match", "张三 五年Java后端",
        {"name": "张三"},
        {"request_id": 1, "title": "Java工程师", "job_description": "需要Spring"},
    )
    assert result["score"] == 82
    assert result["recommendation"] == "recommend"
    assert result["model"] == "deepseek-chat"
    assert result["dimensions"][0]["name"] == "技术栈匹配"


def test_score_resume_general_ok(monkeypatch):
    _mock_chat(monkeypatch, '{"score": 70, "summary": "总体合格", "dimensions": [], '
                            '"highlights": [], "risks": [], "recommendation": "maybe"}')
    result = resume_scorer.score_resume(SETTINGS, "general", "李四 简历", None, None)
    assert result["score"] == 70
    assert result["recommendation"] == "maybe"


def test_score_clamped(monkeypatch):
    _mock_chat(monkeypatch, '{"score": 150, "summary": "s", "dimensions": '
                            '[{"name": "a", "score": -3, "comment": "c"}], '
                            '"highlights": [], "risks": [], "recommendation": "bad-value"}')
    result = resume_scorer.score_resume(SETTINGS, "general", "简历", None, None)
    assert result["score"] == 100
    assert result["dimensions"][0]["score"] == 0
    assert result["recommendation"] == "maybe"  # 非法枚举回退


def test_score_list_truncated(monkeypatch):
    _mock_chat(monkeypatch, '{"score": 50, "summary": "s", "dimensions": [], '
                            '"highlights": ["a","b","c","d","e","f","g"], '
                            '"risks": [], "recommendation": "maybe"}')
    result = resume_scorer.score_resume(SETTINGS, "general", "简历", None, None)
    assert len(result["highlights"]) == 5


def test_invalid_json_raises(monkeypatch):
    _mock_chat(monkeypatch, "这不是JSON")
    with pytest.raises(llm_client.LLMError):
        resume_scorer.score_resume(SETTINGS, "general", "简历", None, None)


def test_match_requires_job():
    with pytest.raises(llm_client.LLMError):
        resume_scorer.score_resume(SETTINGS, "match", "简历", None, None)


def test_invalid_mode():
    with pytest.raises(llm_client.LLMError):
        resume_scorer.score_resume(SETTINGS, "unknown", "简历", None, None)
