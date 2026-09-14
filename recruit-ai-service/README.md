# recruit-ai-service

Python AI服务，为 recruit-platform 提供AI能力支持。

---

## 技术栈

| 组件 | 版本 | 说明 |
|---|---|---|
| Python | 3.11+ | |
| FastAPI | 0.115+ | Web框架 |
| Ollama | latest | 本地模型推理引擎 |
| LangChain | 0.3+ | Agent框架 |
| PyTorch | 2.5+ | 深度学习框架 |
| Transformers | 4.46+ | HuggingFace模型库 |
| MLflow | 2.16+ | 实验管理 |
| ChromaDB | 0.5+ | 向量数据库 |

---

## 目录结构

```
recruit-ai-service/
├── main.py                      # FastAPI应用入口
├── requirements.txt             # Python依赖
├── Dockerfile                   # Docker镜像
├── .env.example                 # 环境变量模板
├── routers/                     # API路由
│   ├── resume.py               # 简历相关接口
│   ├── job.py                  # 职位相关接口
│   ├── talent.py               # 人才推荐接口
│   └── training.py             # 模型训练接口
├── services/                    # 业务逻辑
│   ├── resume_parser.py        # 简历解析服务
│   ├── resume_scorer.py        # 简历评分服务
│   ├── jd_generator.py         # JD生成服务
│   ├── talent_recommender.py   # 人才推荐服务
│   └── model_trainer.py        # 模型训练服务
├── models/                      # 模型定义
│   ├── local/                  # 本地模型（Ollama）
│   └── remote/                 # 云端API封装
├── agents/                      # Agent编排
│   ├── recruitment_agent.py    # 招聘流程Agent
│   └── graph_builder.py        # LangGraph构建器
├── consumers/                   # MQ消费者
│   ├── resume_consumer.py      # 简历解析队列
│   └── training_consumer.py    # 训练任务队列
├── utils/                       # 工具类
│   ├── minio_client.py         # MinIO客户端
│   ├── mysql_client.py         # MySQL客户端
│   ├── redis_client.py         # Redis客户端
│   └── logger.py               # 日志配置
├── config/                      # 配置管理
│   ├── settings.py             # 配置类
│   └── prompts/                # Prompt模板
│       ├── resume_parse.txt
│       ├── resume_score.txt
│       └── jd_generate.txt
├── training/                    # 模型训练
│   ├── datasets/               # 训练数据集
│   ├── scripts/                # 训练脚本
│   │   ├── finetune_qwen.py
│   │   └── finetune_bge.py
│   └── experiments/            # MLflow实验
└── tests/                       # 测试
    ├── test_resume_parser.py
    └── test_resume_scorer.py
```

---

## 本地启动

### 前置依赖

1. **安装Ollama**（本地模型推理引擎）：

```bash
# macOS
brew install ollama

# 启动Ollama服务
ollama serve

# 拉取基础模型
ollama pull qwen2.5:7b
ollama pull bge-large-zh-v1.5
```

2. **安装Python依赖**：

```bash
cd recruit-ai-service
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

3. **配置环境变量**：

```bash
cp .env.example .env
# 编辑 .env 文件，填入配置
```

### 启动服务

```bash
# 开发模式（自动重载）
uvicorn main:app --reload --port 8000

# 生产模式
uvicorn main:app --host 0.0.0.0 --port 8000 --workers 4
```

### 访问API文档

- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

---

## 阶段1实现（MVP）

### 当前实现的接口

| 接口 | 路径 | 说明 | 状态 |
|---|---|---|---|
| 简历解析 | POST /api/v1/resume/parse | 云端API（智谱） | ✅ |
| 简历评分 | POST /api/v1/resume/score | 规则+向量 | ✅ |
| JD生成 | POST /api/v1/job/generate-jd | 云端API（OpenAI） | ✅ |
| 人才推荐 | POST /api/v1/talent/recommend | 向量搜索 | 🚧 |

### 数据积累策略

- ✅ 每次AI调用都记录输入输出
- ✅ HR修正时保存为训练样本
- ✅ 目标：积累100+条高质量标注数据

---

## 阶段2实现（优化）

### 本地模型切换

| 功能 | 云端模型 | 本地模型 | 切换时间 |
|---|---|---|---|
| 简历解析 | 智谱GLM-4 | Qwen2.5-7B（微调） | 第2个月 |
| 简历评分 | - | BGE-large-zh（微调） | 第3个月 |

### 模型微调流程

```bash
# 1. 准备训练数据
python training/scripts/prepare_dataset.py \
  --input training/datasets/raw/ \
  --output training/datasets/processed/

# 2. 微调Qwen2.5（简历解析）
llamafactory-cli train \
  --config training/configs/qwen_resume.yaml

# 3. 导出模型到Ollama
python training/scripts/export_to_ollama.py \
  --checkpoint checkpoints/qwen-resume-v1 \
  --model-name qwen-resume
```

---

## 与Java服务集成

### 同步调用示例

**Java端**：

```java
// 调用AI服务解析简历
ResumeParseResult result = aiService.parseResumeSync(file, jobId);
```

**Python端**：

```python
@router.post("/api/v1/resume/parse")
async def parse_resume(file: UploadFile, job_id: int):
    result = await resume_parser.parse(file, job_id)
    return result
```

### 异步调用示例

**Java端**：

```java
// 发送MQ消息
aiAsyncService.parseResumeAsync(fileUrl, applicationId);
```

**Python端消费者**：

```python
# consumers/resume_consumer.py
# 从RabbitMQ消费任务，处理后回调Java服务
```

详见：[Java-Python集成规范](../docs/conventions/java-python-integration.md)

---

## 模型管理

### 本地模型列表

```bash
# 查看已安装的模型
ollama list

# 运行模型测试
ollama run qwen-resume "解析这份简历..."

# 删除模型
ollama rm qwen-resume
```

### MLflow实验追踪

```bash
# 启动MLflow UI
mlflow ui --port 5000

# 访问 http://localhost:5000 查看实验
```

---

## 测试

```bash
# 运行所有测试
pytest

# 运行特定测试
pytest tests/test_resume_parser.py -v

# 生成覆盖率报告
pytest --cov=services --cov-report=html
```

---

## Docker部署

```bash
# 构建镜像
docker build -t recruit-ai-service:latest .

# 运行容器
docker run -d \
  --name recruit-ai-service \
  -p 8000:8000 \
  -v ./models:/app/models \
  -e OLLAMA_HOST=host.docker.internal:11434 \
  recruit-ai-service:latest
```

---

## 监控与日志

### 日志配置

```python
# utils/logger.py
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('logs/app.log'),
        logging.StreamHandler()
    ]
)
```

### 性能监控

```bash
# 查看API响应时间
tail -f logs/app.log | grep "duration"

# 监控Ollama资源占用
ollama ps
```

---

## 相关文档

- [AI能力集成架构](../docs/architecture/ai-integration-architecture.md)
- [Java-Python集成规范](../docs/conventions/java-python-integration.md)
- [模型训练Pipeline](../docs/architecture/model-training-pipeline.md)

---

## 当前状态

**阶段1（MVP）**：基础框架搭建中，云端API集成优先

**下一步**：
1. 完成基础目录结构
2. 实现简历解析接口（智谱API）
3. 实现简历评分接口（规则+向量）
4. 对接Java服务
