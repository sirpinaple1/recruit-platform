# AI能力集成架构设计

> **文档版本**：v1.0  
> **更新日期**：2026-09-11  
> **状态**：设计评审阶段

---

## 一、总体定位

招聘管理系统深度集成AI能力，采用**渐进式本地化策略**：从云端API起步快速验证，逐步迁移到本地模型降低成本、提升性能、强化隐私保护，最终通过模型微调和RLHF实现业务定制化。

### 核心目标

1. **隐私优先**：简历解析等敏感数据处理本地化
2. **成本可控**：高频调用场景使用本地模型（目标降低AI成本90%）
3. **持续优化**：建立人类反馈闭环，模型越用越准
4. **技术锻炼**：通过真实业务场景掌握模型微调能力

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────┐
│               前端层（H5门户 + Web后台）                  │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────┴─────────────────────────────────┐
│         API Gateway（recruit-server, Spring Boot）       │
│  • 业务编排 • 状态机管理 • 权限控制 • 钉钉集成          │
└─────┬─────────────────┬────────────────┬────────────────┘
      │                 │                │
      │ 业务逻辑        │ AI能力调用     │ 定时任务
      ▼                 ▼                ▼
┌─────────────┐   ┌──────────────────────────────┐
│  MySQL      │   │   recruit-ai-service         │
│  Redis      │   │   (Python, FastAPI)          │
│  MinIO      │   │   • LangChain Agent编排      │
└─────────────┘   │   • Ollama本地推理           │
                  │   • MLflow实验追踪            │
                  │   • ChromaDB向量数据库        │
                  └────────┬─────────────────────┘
                           │
                    ┌──────┴──────┐
                    ▼              ▼
              ┌───────────┐  ┌─────────────┐
              │ 本地模型   │  │ 云端API      │
              │ (Ollama)   │  │ (智谱/OpenAI)│
              │ • Qwen2.5  │  │              │
              │ • BGE      │  │              │
              └───────────┘  └─────────────┘
```

---

## 三、AI能力分层设计

### 3.1 能力矩阵（三阶段演进）

| AI功能 | 阶段1（MVP） | 阶段2（优化） | 阶段3（深度） | 优先级 |
|---|---|---|---|---|
| **简历解析** | 智谱API | **Qwen2.5-7B**（微调） | 自训练小模型 | P0 |
| **简历评分** | 规则+embedding | **BGE-large**（微调） | 排序模型 | P0 |
| **JD生成** | GPT-4o-mini | few-shot优化 | Qwen2.5-14B | P1 |
| **智能推荐** | 向量相似度 | **Reranker模型** | 强化学习 | P1 |
| **面试问题生成** | 云端API | 云端API | 本地fine-tune | P2 |
| **Agent编排** | 简单规则 | LangGraph | 自定义框架 | P1 |

### 3.2 本地 vs 云端决策原则

**本地模型适用场景**：
- ✅ 隐私敏感（简历包含身份证号、手机号）
- ✅ 高频调用（每天几百次简历解析）
- ✅ 延迟敏感（HR需要实时看到评分）
- ✅ 可微调（有标注数据积累）

**云端API适用场景**：
- ✅ 创意性强（JD生成需要文案能力）
- ✅ 低频调用（成本可控）
- ✅ 数据量少（难以训练）
- ✅ 需要最新能力（大模型持续更新）

---

## 四、技术栈选型

### 4.1 后端服务（Java）

```yaml
框架: Spring Boot 4.1.1
持久层: MyBatis-Plus 3.5.17
消息队列: RabbitMQ (AI异步任务)
对象存储: MinIO (简历文件)
```

### 4.2 AI服务（Python）

```yaml
Web框架: FastAPI
Agent框架: LangChain / LangGraph
本地推理: Ollama (Apple Silicon优化)
模型训练: PyTorch + Transformers + LLaMA-Factory
实验管理: MLflow
向量数据库: ChromaDB (开发) / Milvus (生产)
```

### 4.3 本地模型选型（Apple Silicon M系列优化）

| 模型 | 参数量 | 用途 | 性能（M1/M2/M3） |
|---|---|---|---|
| **Qwen2.5-7B-Instruct** | 7B | 简历解析、信息抽取 | 8-12 tokens/s（量化） |
| **bge-large-zh-v1.5** | 326M | 中文embedding | 实时（毫秒级） |
| **bge-reranker-large** | 326M | 候选人重排序 | 实时 |
| Llama3.2-3B | 3B | 备选方案 | 15-20 tokens/s |

> **关键技术**：通过Ollama + GGUF量化，M系列Mac可流畅运行7B模型

---

## 五、服务间通信

### 5.1 Java → Python 调用方式

```java
// 同步调用（实时场景，如HR手动触发）
@Service
public class AIService {
    @Value("${ai.service.url}")
    private String aiServiceUrl;
    
    private final RestTemplate restTemplate;
    
    public ResumeParseResult parseResumeSync(MultipartFile file) {
        return restTemplate.postForObject(
            aiServiceUrl + "/api/v1/resume/parse",
            createMultipartRequest(file),
            ResumeParseResult.class
        );
    }
}

// 异步调用（批量场景，如候选人投递）
@Service
public class AIAsyncService {
    private final RabbitTemplate rabbitTemplate;
    
    public void parseResumeAsync(String fileUrl, String applicationId) {
        rabbitTemplate.convertAndSend(
            "ai.resume.parse",
            new ResumeParseTask(fileUrl, applicationId)
        );
    }
}
```

### 5.2 Python消费MQ任务

```python
# ai_service/consumers/resume_consumer.py
import pika
from services.resume_parser import ResumeParser

def callback(ch, method, properties, body):
    task = json.loads(body)
    
    # 1. 从MinIO下载简历文件
    file_content = download_from_minio(task['file_url'])
    
    # 2. 调用AI解析
    parser = ResumeParser()
    result = parser.parse(file_content)
    
    # 3. 回写结果到MySQL（通过Java API）
    post_result_to_java(task['application_id'], result)
    
    ch.basic_ack(delivery_tag=method.delivery_tag)

# 启动消费者
connection = pika.BlockingConnection(pika.ConnectionParameters('localhost'))
channel = connection.channel()
channel.queue_declare(queue='ai.resume.parse', durable=True)
channel.basic_consume(queue='ai.resume.parse', on_message_callback=callback)
channel.start_consuming()
```

---

## 六、阶段1实现（MVP）

### 6.1 架构特点

- ✅ **快速验证**：全部AI能力走云端API，无需模型训练
- ✅ **数据积累**：每次调用都记录输入输出，为后续微调准备
- ✅ **简单部署**：Java服务+Python服务+云端API，无GPU依赖

### 6.2 关键实现：简历解析

**Python AI服务（FastAPI）**：

```python
from fastapi import APIRouter, UploadFile
from zhipuai import ZhipuAI
import pymupdf4llm

router = APIRouter()
client = ZhipuAI(api_key=os.getenv("ZHIPU_API_KEY"))

@router.post("/resume/parse")
async def parse_resume(file: UploadFile):
    # 1. PDF转Markdown（保留结构）
    md_text = pymupdf4llm.to_markdown(file.file)
    
    # 2. 调用智谱AI提取结构化信息
    response = client.chat.completions.create(
        model="glm-4-flash",
        messages=[
            {"role": "system", "content": RESUME_PARSE_SYSTEM_PROMPT},
            {"role": "user", "content": md_text}
        ],
        response_format={"type": "json_object"}
    )
    
    parsed = json.loads(response.choices[0].message.content)
    
    # 3. 本地评分（规则+向量）
    score = calculate_score(parsed, job_requirements)
    
    # 4. 🔥 关键：保存为训练数据
    save_to_training_dataset(md_text, parsed, score)
    
    return ResumeParseResult(**parsed, ai_score=score)
```

**数据积累策略**：

```python
# 每次解析都保存，用于后续微调
def save_to_training_dataset(raw_text, parsed_result, score):
    sample = {
        "input": raw_text,
        "output": parsed_result,
        "score": score,
        "human_feedback": None,  # 等HR修正后回填
        "created_at": datetime.now().isoformat(),
        "model_version": "zhipu-glm-4-flash"
    }
    # 保存到MinIO + 元数据入MySQL
    training_data_repo.save(sample)
```

### 6.3 成本估算（阶段1）

| 项目 | 调用量 | 单价 | 月成本 |
|---|---|---|---|
| 简历解析（智谱API） | 1000次 | ¥0.5/次 | ¥500 |
| JD生成（GPT-4o-mini） | 50次 | ¥0.02/次 | ¥1 |
| **合计** | - | - | **¥501** |

---

## 七、阶段2实现（优化）

### 7.1 目标

- ✅ 关键路径本地化（简历解析、评分）
- ✅ 降低AI成本90%（¥500 → ¥50/月）
- ✅ 提升性能3倍（2-3s → 0.8s）
- ✅ 掌握模型微调技能

### 7.2 微调Qwen2.5-7B（简历解析）

**为什么选Qwen2.5**：
- ✅ 中文理解能力强
- ✅ Apple Silicon优化好（MLX/Ollama）
- ✅ 支持128K上下文
- ✅ 指令跟随能力强

**微调流程**：

```bash
# 1. 准备数据集（从阶段1积累的数据+HR修正）
# training_data.jsonl 格式：
{
  "messages": [
    {"role": "system", "content": "你是简历解析助手..."},
    {"role": "user", "content": "【简历原文】"},
    {"role": "assistant", "content": "{\"name\":\"张三\",...}"}
  ]
}

# 2. 使用LLaMA-Factory微调（M系列友好）
llamafactory-cli train \
  --model_name_or_path Qwen/Qwen2.5-7B-Instruct \
  --data resume_parse \
  --output_dir ./checkpoints/qwen-resume-v1 \
  --lora_rank 8 \
  --num_train_epochs 3 \
  --learning_rate 1e-4 \
  --bf16 true

# 3. 合并LoRA权重 + 转GGUF
llamafactory-cli export ...
python llama.cpp/convert.py ... --outtype q4_0

# 4. 导入Ollama
ollama create qwen-resume -f Modelfile
```

**切换到本地模型**：

```python
# ai_service/services/resume_parser.py
from langchain_community.llms import Ollama

class ResumeParser:
    def __init__(self):
        self.llm = Ollama(
            model="qwen-resume",
            base_url="http://localhost:11434"
        )
    
    def parse(self, file_content):
        md_text = pymupdf4llm.to_markdown(file_content)
        response = self.llm.invoke(
            RESUME_PARSE_PROMPT + "\n\n" + md_text
        )
        return json.loads(response)
```

### 7.3 预期效果

| 指标 | 阶段1（云端） | 阶段2（本地） | 提升 |
|---|---|---|---|
| 准确率 | 85% | **92%** | +7% |
| 延迟 | 2-3s | **0.8s** | 快3倍 |
| 月成本 | ¥500 | **¥50** | 降90% |

---

## 八、阶段3实现（深度）

### 8.1 Agent编排（LangGraph）

```python
from langgraph.graph import StateGraph
from typing import TypedDict

class RecruitmentState(TypedDict):
    resume_file: str
    job_id: str
    parsed_data: dict
    score: float
    recommendations: list

def create_recruitment_graph():
    workflow = StateGraph(RecruitmentState)
    
    # 定义节点
    workflow.add_node("parse", parse_resume_node)
    workflow.add_node("score", score_resume_node)
    workflow.add_node("recommend", recommend_node)
    
    # 定义条件边
    workflow.add_conditional_edges(
        "score",
        lambda state: "recommend" if state["score"] > 0.6 else END
    )
    
    workflow.set_entry_point("parse")
    return workflow.compile()

# 使用
graph = create_recruitment_graph()
result = graph.invoke({
    "resume_file": "resume.pdf",
    "job_id": "job_123"
})
```

### 8.2 人类反馈闭环（RLHF）

```python
# HR修正AI结果时触发
@router.post("/resume/{id}/correct")
async def correct_resume(id: str, corrected_data: dict):
    original = get_original_parse(id)
    
    # 保存为负样本
    preference_sample = {
        "input": original["raw_text"],
        "output_wrong": original["parsed"],
        "output_correct": corrected_data,
        "feedback_type": "correction"
    }
    save_preference_data(preference_sample)
    
    # 触发增量训练（积累100条后）
    if count_pending_samples() >= 100:
        trigger_incremental_training()
```

### 8.3 MLflow实验追踪

```python
import mlflow

mlflow.set_experiment("resume-parsing")

with mlflow.start_run(run_name="qwen-resume-v2"):
    mlflow.log_params({
        "model": "Qwen2.5-7B",
        "lora_rank": 8,
        "epochs": 3
    })
    
    model = train_model(...)
    
    mlflow.log_metrics({
        "accuracy": 0.92,
        "f1_score": 0.89,
        "inference_speed": 12.3
    })
    
    mlflow.pytorch.log_model(model, "model")
```

---

## 九、部署架构

### 9.1 开发环境（MacBook本地）

```yaml
# docker-compose.yml
version: '3.8'
services:
  mysql:
    image: mysql:8.0
  redis:
    image: redis:7-alpine
  minio:
    image: minio/minio
  chromadb:
    image: chromadb/chroma
  
  recruit-server:
    build: ./recruit-server
    ports: ["8080:8080"]
  
  recruit-ai-service:
    build: ./recruit-ai-service
    ports: ["8000:8000"]
    volumes:
      - ./models:/models
    environment:
      - OLLAMA_HOST=host.docker.internal:11434

# Ollama直接在Mac上运行（性能更好）
```

### 9.2 生产环境（云端）

```
Kubernetes Cluster
├── recruit-server (多副本)
├── recruit-ai-service (GPU节点)
├── MySQL (RDS)
├── Redis (ElastiCache)
├── Milvus (向量数据库)
└── MinIO (对象存储)
```

---

## 十、学习路径与里程碑

### 第1个月：基础搭建
- [ ] Java + Python服务架构
- [ ] 接入智谱API实现简历解析
- [ ] 向量搜索（BGE-large-zh）
- [ ] 核心业务流程

### 第2个月：本地模型入门
- [ ] 安装Ollama，跑通Qwen2.5-7B
- [ ] 积累100+条简历数据（带HR修正）
- [ ] LLaMA-Factory第一次微调
- [ ] A/B测试对比

### 第3个月：模型优化
- [ ] 微调embedding模型
- [ ] 增量训练pipeline
- [ ] MLflow管理实验
- [ ] 性能优化（量化、加速）

### 第4个月：Agent进阶
- [ ] LangGraph编排
- [ ] 多Agent协作
- [ ] RLHF闭环
- [ ] 端到端推荐模型

---

## 十一、相关文档

- [模型训练Pipeline](./model-training-pipeline.md)
- [Java-Python集成指南](../conventions/java-python-integration.md)
- [架构总览](./overview.md) / [ADR 索引](./adr/README.md)

> ⚠️ 本文描述的是**尚未实装的域**（AI 服务一期未落地）。阅读时不要把这里的表结构/接口当成系统现状，现状见 `overview.md` §已知结构缺口。
>
> 以下文档**尚未撰写**（勿按链接查找）：`ai-service-api-design.md`（AI 服务 API 设计）、`data-annotation-guidelines.md`（数据标注规范）。

---

**下一步**：完成 recruit-ai-service 服务骨架搭建
