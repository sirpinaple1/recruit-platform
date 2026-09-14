# recruit-ai-service AGENTS.md

AI服务（Python / FastAPI）AI 协作约定。

## 工作原则

- 修改代码前必须确认需求明确。
- 新增接口时，参考现有代码风格。
- 实现方案采用简洁方式，不做过度设计。
- 每次告知技术实现方案（新增/修改哪些文件）。

## 硬性规则

- 所有接口必须使用 Pydantic 校验参数。
- 统一使用 FastAPI 的异常处理机制（`HTTPException`）。
- 禁止使用 `print`，必须使用 `logging` 模块。
- 长时间任务（>10s）必须返回任务ID，提供查询接口。
- 敏感信息（API Key、密码）必须从环境变量读取，禁止硬编码。
- 所有AI调用都必须记录到训练数据集（用于后续微调）。

## 模型调用规范

### 云端API调用

- 智谱API用于简历解析（阶段1）
- OpenAI API用于JD生成（阶段1）
- 调用失败时必须有降级方案
- API Key通过环境变量传入

### 本地模型调用

- 统一通过 Ollama 调用本地模型
- 模型名称通过配置文件管理
- 推理失败时记录错误日志并抛出异常

## 数据积累规范

每次AI调用都必须保存训练样本：

```python
# 保存格式
training_sample = {
    "input": raw_input,           # 原始输入
    "output": ai_output,          # AI输出
    "human_feedback": None,       # 等待HR修正
    "model_version": "...",       # 模型版本
    "created_at": "..."          # 时间戳
}
```

保存位置：
- 元数据存MySQL（`ai_training_samples`表）
- 文件存MinIO（`training-data`桶）

## 接口设计规范

### 请求格式

```python
from pydantic import BaseModel, Field

class ResumeParseRequest(BaseModel):
    file: UploadFile
    job_id: int = Field(..., gt=0, description="职位ID")
    parse_options: Optional[dict] = None
```

### 响应格式

```python
class ResumeParseResponse(BaseModel):
    name: str
    phone: str
    email: str
    score: float = Field(..., ge=0.0, le=1.0)
    confidence: float
```

### 错误处理

```python
from fastapi import HTTPException

@router.post("/parse")
async def parse_resume(request: ResumeParseRequest):
    try:
        result = await resume_parser.parse(request)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"解析失败: {e}")
        raise HTTPException(status_code=500, detail="服务器内部错误")
```

## 日志规范

```python
import logging

logger = logging.getLogger(__name__)

# 记录关键操作
logger.info(f"开始解析简历, job_id={job_id}, filename={filename}")

# 记录性能
logger.info(f"解析完成, duration={duration:.2f}s, score={score}")

# 记录错误（包含上下文）
logger.error(f"解析失败, job_id={job_id}, error={str(e)}", exc_info=True)
```

## 测试规范

- 每个service必须有对应的单元测试
- 每个router必须有集成测试
- 测试文件命名：`test_<module_name>.py`
- 使用 pytest fixture 管理测试数据

```python
# tests/test_resume_parser.py
import pytest
from services.resume_parser import ResumeParser

@pytest.fixture
def sample_resume():
    return open("tests/fixtures/sample_resume.pdf", "rb")

def test_parse_resume(sample_resume):
    parser = ResumeParser()
    result = parser.parse(sample_resume)
    assert result["name"] is not None
    assert 0 <= result["score"] <= 1
```

## 模型训练规范

### 训练脚本命名

- 格式：`finetune_<model_name>_<version>.py`
- 示例：`finetune_qwen_v1.py`

### MLflow实验命名

- 格式：`<task>-<model>-<date>`
- 示例：`resume-parsing-qwen-20260911`

### 模型文件存放

```
training/
├── datasets/
│   ├── raw/              # 原始数据
│   └── processed/        # 处理后的数据
├── checkpoints/          # 训练检查点
│   └── qwen-resume-v1/
├── models/               # 导出的模型
│   └── qwen-resume.gguf
└── experiments/          # MLflow实验记录
```

## 与Java服务集成规范

详见：`../docs/conventions/java-python-integration.md`

关键点：
- 同步接口超时时间 < 30s
- 长时间任务使用MQ异步处理
- 所有接口支持幂等性（idempotency key）
- 传递 `X-Trace-Id` 用于链路追踪

## 相关文档

- 全项目AI协作约定：`../AGENTS.md`
- AI能力集成架构：`../docs/architecture/ai-integration-architecture.md`
- Java-Python集成规范：`../docs/conventions/java-python-integration.md`
