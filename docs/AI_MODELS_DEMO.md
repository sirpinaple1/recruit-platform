# 🤖 Ollama 本地模型功能演示

## 📋 模型清单

| 模型 | 大小 | 用途 | 技术特点 |
|------|------|------|----------|
| **qwen2.5:7b** | 4.7 GB | 简历解析与评分 | 大语言模型（LLM），理解中文，推理速度 27 tokens/s |
| **bge-m3** | 1.2 GB | 简历向量化 | 嵌入模型，生成 1024 维向量，支持语义相似度搜索 |

---

## 🎯 模型 1: Qwen2.5 - 简历解析与理解

### 功能：结构化信息提取

**输入**: 非结构化的简历文本  
**输出**: 结构化的 JSON 数据

### 实际演示

**原始简历**:
```text
张三
联系方式: 138****8888 | zhangsan@email.com
教育背景: 
- 2018-2022 清华大学 计算机科学与技术 本科
工作经历:
- 2022.07-至今 字节跳动 Java后端工程师
  负责推荐系统开发，使用Spring Boot、Redis、Kafka
  优化接口性能，QPS提升30%
技能:
- Java, Spring Boot, MySQL, Redis, Kafka
- Python, FastAPI, 机器学习基础
```

**解析结果**:
```json
{
  "name": "张三",
  "phone": "138****8888",
  "email": "zhangsan@email.com",
  "education": [
    {
      "school": "清华大学",
      "major": "计算机科学与技术",
      "degree": "本科",
      "start_year": "2018",
      "end_year": "2022"
    }
  ],
  "work_experience": [
    {
      "company": "字节跳动",
      "title": "Java后端工程师",
      "start_date": "2022.07",
      "end_date": "至今",
      "description": "负责推荐系统开发，使用Spring Boot、Redis、Kafka\n优化接口性能，QPS提升30%"
    }
  ],
  "skills": [
    "Java", "Spring Boot", "MySQL", "Redis", "Kafka",
    "Python", "FastAPI", "机器学习基础"
  ]
}
```

### 应用场景

1. **简历解析**：自动提取候选人的基本信息、教育背景、工作经历
2. **信息标准化**：统一不同格式的简历数据
3. **数据入库**：结构化数据可直接存入 MySQL
4. **智能评分**：基于提取的信息进行候选人评估

### 性能指标

- **推理速度**: 27 tokens/s（本地 M 系列芯片）
- **首次加载**: ~2 秒（模型加载时间）
- **后续调用**: <1 秒（利用缓存）
- **上下文长度**: 支持 32k tokens

---

## 🎯 模型 2: bge-m3 - 语义向量化与相似度搜索

### 功能：将文本转换为向量，实现语义搜索

**输入**: 简历文本或职位描述  
**输出**: 1024 维语义向量

### 实际演示

**测试场景**: 为一个 Java 后端岗位匹配最合适的候选人

**职位要求**:
```
招聘Java后端工程师，要求熟悉Spring Boot、MySQL、Redis、消息队列
```

**候选人简历**:
- **简历1**: Java后端工程师，3年经验，熟悉Spring Boot、MySQL、Redis
- **简历2**: Python开发工程师，2年经验，熟悉Django、PostgreSQL、Celery
- **简历3**: Java开发工程师，2年经验，熟悉Spring Cloud、MySQL、Redis、Kafka

**向量化结果**:
```
向量维度: 1024
示例向量（前10维）: [-2.17, 0.31, -0.57, 0.91, -0.23, -0.62, -0.60, -0.98, 0.33, -0.18]
```

**相似度计算结果**:
```
简历1 相似度: 0.8875 (88.75%) ⭐⭐⭐⭐
简历2 相似度: 0.6070 (60.70%) ⭐⭐⭐
简历3 相似度: 0.7482 (74.82%) ⭐⭐⭐
```

**推荐排序**:
1. 简历1 (Java后端, 3年, Spring Boot) - 匹配度: **88.75%** ✅
2. 简历3 (Java, 2年, Spring Cloud) - 匹配度: 74.82%
3. 简历2 (Python, 2年, Django) - 匹配度: 60.70%

### 应用场景

1. **智能搜索**：输入职位要求，自动找到最匹配的候选人
2. **简历去重**：识别相似或重复的简历
3. **推荐系统**：为 HR 推荐合适的候选人
4. **职位匹配**：为候选人推荐合适的职位

### 技术原理

**向量化**: 将文本转换为高维空间中的点
```
"Java工程师" → [0.12, -0.45, 0.89, ..., 0.34]  (1024维)
"Python工程师" → [0.08, -0.23, 0.11, ..., 0.67]
```

**相似度计算**: 使用余弦相似度衡量两个向量的接近程度
```
cosine_similarity = (A · B) / (|A| × |B|)

值域: [-1, 1]
- 1.0: 完全相同
- 0.9-0.8: 非常相似 ⭐⭐⭐⭐⭐
- 0.8-0.7: 比较相似 ⭐⭐⭐⭐
- 0.7-0.6: 一般相似 ⭐⭐⭐
- < 0.6: 不太相似 ⭐⭐
```

---

## 🔄 两个模型的协作流程

### 完整的简历处理流程

```
1️⃣ 简历上传 (PDF/Word)
        ↓
2️⃣ 文本提取
        ↓
3️⃣ Qwen2.5 解析 → 结构化 JSON
        ↓
4️⃣ 存入 MySQL 数据库
        ↓
5️⃣ bge-m3 向量化 → 1024 维向量
        ↓
6️⃣ 存入 ChromaDB 向量数据库
        ↓
7️⃣ 实现智能搜索与匹配
```

### 实际业务案例

**场景**: HR 发布新职位，系统自动推荐候选人

```python
# 1. 职位要求向量化
job_desc = "招聘高级Java工程师，5年以上经验，精通Spring Cloud微服务架构"
job_vector = bge_m3.embed(job_desc)

# 2. 在向量数据库中搜索相似简历
results = chromadb.query(
    vector=job_vector,
    top_k=10  # 返回前10名候选人
)

# 3. 对于每个候选人，使用 Qwen2.5 生成详细评估
for candidate in results:
    evaluation = qwen2.5.evaluate(
        resume=candidate.text,
        job_requirement=job_desc
    )
    print(f"候选人: {candidate.name}")
    print(f"匹配度: {candidate.similarity * 100:.1f}%")
    print(f"评估: {evaluation}")
```

---

## 📊 性能对比

### 本地模型 vs 云端 API

| 指标 | 本地 Ollama | 云端 API (如 OpenAI) |
|------|-------------|---------------------|
| **成本** | 0元（硬件已有） | 约 ¥0.02-0.10/次 |
| **速度** | 2-5秒 | 1-3秒 |
| **隐私** | ✅ 数据不出本地 | ⚠️ 数据上传云端 |
| **离线可用** | ✅ 支持 | ❌ 需要网络 |
| **并发能力** | 受限于本地硬件 | 几乎无限 |
| **模型定制** | ✅ 可微调 | ❌ 固定模型 |

### 适用场景建议

**使用本地模型**:
- ✅ 简历包含敏感信息（不能上传云端）
- ✅ 开发测试阶段（降低成本）
- ✅ 日处理量 < 1000 份简历
- ✅ 需要离线运行

**使用云端 API**:
- ✅ 需要最新最强的模型能力
- ✅ 日处理量 > 5000 份简历
- ✅ 需要高并发能力
- ✅ 预算充足

**混合方案（推荐）**:
- 开发环境：本地模型（快速迭代）
- 生产环境：云端 API（性能稳定）
- 敏感数据：本地处理
- 批量任务：云端处理

---

## 🧪 快速测试命令

### 测试 Qwen2.5 模型
```bash
ollama run qwen2.5:7b "请解析这份简历: 张三，Java工程师，3年经验"
```

### 测试 bge-m3 向量化
```bash
curl -X POST http://localhost:11434/api/embeddings \
  -d '{"model": "bge-m3", "prompt": "Java后端工程师"}' | jq
```

### 运行完整演示
```bash
# 简历解析演示
ollama run qwen2.5:7b "$(cat /tmp/test_resume.txt)"

# 向量相似度演示
python3 /tmp/test_embedding.py
```

---

## 🚀 在 recruit-platform 中的应用

### 已实现的功能（数据库准备）

```sql
-- 简历解析结果存储
CREATE TABLE candidate_resume (
    id BIGINT PRIMARY KEY,
    candidate_id BIGINT,
    file_path VARCHAR(500),
    parsed_content JSON,  -- ← Qwen2.5 解析的结构化数据
    ...
);

-- 简历评分结果
CREATE TABLE resume_score (
    id BIGINT PRIMARY KEY,
    resume_id BIGINT,
    score DECIMAL(5,2),
    score_detail JSON,    -- ← Qwen2.5 生成的评分依据
    ...
);
```

### 待开发的 API（Week 2-3）

```java
// 简历上传与解析
POST /api/resume/upload
Response: {
    "resume_id": 123,
    "parsed_data": { ... },     // Qwen2.5 解析结果
    "vector_stored": true        // bge-m3 向量已存储
}

// 智能搜索候选人
POST /api/candidate/search
Request: {
    "job_requirement": "招聘Java工程师...",
    "top_k": 10
}
Response: [
    {
        "candidate_id": 456,
        "name": "张三",
        "similarity": 0.8875,    // bge-m3 计算的相似度
        "match_reason": "..."     // Qwen2.5 生成的匹配理由
    }
]
```

---

## 💡 总结

### Qwen2.5 的核心价值
- **理解能力**: 准确理解中文简历内容
- **提取能力**: 自动提取结构化信息
- **推理能力**: 生成评分和推荐理由

### bge-m3 的核心价值
- **向量化**: 将文本转换为数学向量
- **语义搜索**: 找到"意思相近"而非"字面相同"的内容
- **高效检索**: 在 10 万份简历中秒级找到最匹配的

### 两者结合的威力
- Qwen2.5 负责"理解"（What）
- bge-m3 负责"匹配"（Which）
- 共同实现智能招聘系统 🚀

---

**📝 测试文件位置**:
- 简历样本: `/tmp/test_resume.txt`
- 向量化测试: `/tmp/test_embedding.py`
- 本文档: `docs/AI_MODELS_DEMO.md`
