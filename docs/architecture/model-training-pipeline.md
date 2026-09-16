# 模型训练Pipeline设计

> **文档版本**：v1.0  
> **更新日期**：2026-09-11  
> **状态**：设计评审阶段

---

## 一、总体流程

```
数据积累 → 数据清洗 → 数据标注 → 模型微调 → 模型评估 → 模型部署 → 效果监控
   ↓                                                                    ↓
   └────────────────────────── 人类反馈闭环 ←──────────────────────────┘
```

---

## 二、数据积累

### 2.1 自动积累策略

每次AI调用都自动保存训练样本：

```python
# services/training_data_collector.py
from datetime import datetime
from utils.mysql_client import MySQLClient
from utils.minio_client import MinioClient

class TrainingDataCollector:
    """训练数据收集器"""
    
    def save_sample(self, task_type: str, input_data: dict, output_data: dict, 
                    model_version: str, metadata: dict = None):
        """
        保存训练样本
        
        Args:
            task_type: 任务类型（resume_parse, resume_score, jd_generate）
            input_data: 输入数据
            output_data: AI输出结果
            model_version: 模型版本
            metadata: 额外元数据
        """
        sample_id = generate_uuid()
        
        # 1. 保存文件到MinIO（如有）
        file_url = None
        if "file_content" in input_data:
            file_url = MinioClient().upload(
                bucket="training-data",
                object_name=f"{task_type}/{sample_id}.pdf",
                data=input_data["file_content"]
            )
        
        # 2. 保存元数据到MySQL
        MySQLClient().insert("ai_training_samples", {
            "id": sample_id,
            "task_type": task_type,
            "input_json": json.dumps(input_data, ensure_ascii=False),
            "output_json": json.dumps(output_data, ensure_ascii=False),
            "file_url": file_url,
            "model_version": model_version,
            "human_feedback": None,
            "feedback_at": None,
            "status": "pending",  # pending / reviewed / trained
            "metadata": json.dumps(metadata or {}, ensure_ascii=False),
            "created_at": datetime.now()
        })
        
        return sample_id
```

### 2.2 数据库表结构

```sql
CREATE TABLE ai_training_samples (
    id VARCHAR(64) PRIMARY KEY COMMENT '样本ID',
    task_type VARCHAR(32) NOT NULL COMMENT '任务类型',
    input_json TEXT NOT NULL COMMENT '输入数据（JSON）',
    output_json TEXT NOT NULL COMMENT 'AI输出（JSON）',
    file_url VARCHAR(512) COMMENT '文件URL（MinIO）',
    model_version VARCHAR(64) NOT NULL COMMENT '模型版本',
    human_feedback TEXT COMMENT 'HR修正结果（JSON）',
    feedback_at DATETIME(3) COMMENT '修正时间',
    status VARCHAR(16) NOT NULL COMMENT '状态: pending/reviewed/trained',
    metadata TEXT COMMENT '额外元数据（JSON）',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_task_type (task_type),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI训练样本表';
```

---

## 三、人类反馈（RLHF）

### 3.1 Java端提供修正接口

```java
// com/recruit/controller/AIFeedbackController.java
@RestController
@RequestMapping("/api/feedback")
@Log4j2
public class AIFeedbackController {
    
    private final AIFeedbackService feedbackService;
    
    /**
     * HR修正简历解析结果
     */
    @PostMapping("/resume/{resumeId}/correct")
    public R correctResume(@PathVariable Long resumeId, 
                          @RequestBody ResumeCorrection correction) {
        try {
            feedbackService.saveResumeCorrection(resumeId, correction);
            return R.ok("修正已保存，将用于模型优化");
        } catch (Exception e) {
            log.error("保存修正失败", e);
            return R.error("保存失败");
        }
    }
    
    /**
     * HR调整简历评分
     */
    @PostMapping("/application/{appId}/adjust-score")
    public R adjustScore(@PathVariable Long appId,
                        @RequestBody ScoreAdjustment adjustment) {
        try {
            feedbackService.saveScoreAdjustment(appId, adjustment);
            return R.ok("评分调整已保存");
        } catch (Exception e) {
            log.error("保存调整失败", e);
            return R.error("保存失败");
        }
    }
}
```

### 3.2 Python端处理反馈

```python
# routers/feedback.py
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/v1/feedback", tags=["反馈"])

class HumanFeedback(BaseModel):
    sample_id: str
    corrected_output: dict
    feedback_type: str  # correction / preference
    reason: str

@router.post("/submit")
async def submit_feedback(feedback: HumanFeedback):
    """接收人类反馈"""
    
    # 1. 更新样本状态
    MySQLClient().update(
        "ai_training_samples",
        {"id": feedback.sample_id},
        {
            "human_feedback": json.dumps(feedback.corrected_output),
            "feedback_at": datetime.now(),
            "status": "reviewed"
        }
    )
    
    # 2. 检查是否达到训练阈值
    pending_count = MySQLClient().count(
        "ai_training_samples",
        {"status": "reviewed"}
    )
    
    if pending_count >= 100:
        # 触发增量训练
        trigger_incremental_training()
    
    return {"message": "反馈已保存"}
```

---

## 四、数据准备

### 4.1 数据导出脚本

```python
# training/scripts/export_training_data.py
import json
from utils.mysql_client import MySQLClient
from utils.minio_client import MinioClient

def export_training_data(task_type: str, output_dir: str):
    """
    导出训练数据
    
    Args:
        task_type: 任务类型（resume_parse）
        output_dir: 输出目录
    """
    
    # 1. 从MySQL查询已标注的样本
    samples = MySQLClient().query("""
        SELECT id, input_json, output_json, human_feedback, file_url
        FROM ai_training_samples
        WHERE task_type = %s AND status = 'reviewed'
        ORDER BY created_at
    """, (task_type,))
    
    # 2. 转换为训练格式
    training_data = []
    for sample in samples:
        input_data = json.loads(sample["input_json"])
        
        # 优先使用人类修正，否则用AI输出
        if sample["human_feedback"]:
            output_data = json.loads(sample["human_feedback"])
        else:
            output_data = json.loads(sample["output_json"])
        
        # 构造训练样本
        training_sample = {
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": input_data["text"]},
                {"role": "assistant", "content": json.dumps(output_data, ensure_ascii=False)}
            ]
        }
        training_data.append(training_sample)
    
    # 3. 保存为JSONL格式
    output_file = f"{output_dir}/{task_type}_train.jsonl"
    with open(output_file, "w", encoding="utf-8") as f:
        for item in training_data:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
    
    print(f"导出完成：{len(training_data)} 条样本 -> {output_file}")
```

### 4.2 数据质量检查

```python
# training/scripts/validate_dataset.py
def validate_dataset(file_path: str):
    """
    检查训练数据质量
    
    检查项：
    1. JSON格式是否正确
    2. 必填字段是否完整
    3. 数据是否重复
    4. 标注是否一致
    """
    
    samples = []
    with open(file_path, "r") as f:
        for line in f:
            samples.append(json.loads(line))
    
    # 检查1：格式检查
    for i, sample in enumerate(samples):
        assert "messages" in sample, f"样本{i}缺少messages字段"
        assert len(sample["messages"]) == 3, f"样本{i}消息数量不对"
    
    # 检查2：去重
    unique_inputs = set()
    duplicates = []
    for i, sample in enumerate(samples):
        user_msg = sample["messages"][1]["content"]
        if user_msg in unique_inputs:
            duplicates.append(i)
        unique_inputs.add(user_msg)
    
    if duplicates:
        print(f"⚠️  发现 {len(duplicates)} 条重复样本：{duplicates}")
    
    # 检查3：标注一致性（相似输入是否有相似输出）
    # TODO: 使用embedding检查
    
    print(f"✅ 数据集验证通过：{len(samples)} 条样本")
```

---

## 五、模型微调

### 5.1 微调配置（LLaMA-Factory）

```yaml
# training/configs/qwen_resume_v1.yaml
### 模型路径
model_name_or_path: Qwen/Qwen2.5-7B-Instruct

### 数据集
dataset: resume_parse_v1
template: qwen
cutoff_len: 4096

### 输出路径
output_dir: training/checkpoints/qwen-resume-v1
logging_steps: 10
save_steps: 500
plot_loss: true

### LoRA配置
finetuning_type: lora
lora_rank: 8
lora_alpha: 16
lora_dropout: 0.05
lora_target: all

### 训练超参数
num_train_epochs: 3
per_device_train_batch_size: 1
gradient_accumulation_steps: 8
learning_rate: 0.0001
lr_scheduler_type: cosine
warmup_ratio: 0.1

### 优化
fp16: false
bf16: true  # Apple Silicon支持BF16
gradient_checkpointing: true

### 评估
val_size: 0.1
evaluation_strategy: steps
eval_steps: 500
```

### 5.2 微调脚本

```python
# training/scripts/finetune_qwen.py
import os
import mlflow
from datetime import datetime

def finetune_qwen(config_path: str, experiment_name: str):
    """
    微调Qwen2.5模型
    
    Args:
        config_path: 配置文件路径
        experiment_name: MLflow实验名称
    """
    
    # 1. 设置MLflow实验
    mlflow.set_experiment(experiment_name)
    
    with mlflow.start_run(run_name=f"qwen-resume-{datetime.now().strftime('%Y%m%d-%H%M')}"):
        
        # 2. 记录配置
        with open(config_path) as f:
            config = yaml.safe_load(f)
        mlflow.log_params(config)
        
        # 3. 执行训练
        os.system(f"llamafactory-cli train {config_path}")
        
        # 4. 记录训练指标（从输出解析）
        # TODO: 解析训练日志
        
        # 5. 评估模型
        eval_results = evaluate_model(config["output_dir"])
        mlflow.log_metrics(eval_results)
        
        # 6. 保存模型
        mlflow.log_artifacts(config["output_dir"])
    
    print("微调完成！")

def evaluate_model(checkpoint_dir: str) -> dict:
    """评估模型性能"""
    
    # 加载测试集
    test_samples = load_test_data()
    
    # 加载模型
    model = load_finetuned_model(checkpoint_dir)
    
    # 评估指标
    correct = 0
    total = len(test_samples)
    
    for sample in test_samples:
        prediction = model.predict(sample["input"])
        ground_truth = sample["output"]
        
        # 计算准确率（字段级）
        if compare_outputs(prediction, ground_truth):
            correct += 1
    
    accuracy = correct / total
    
    return {
        "accuracy": accuracy,
        "f1_score": calculate_f1(test_samples, model),
        "inference_speed": measure_speed(model)
    }
```

### 5.3 模型导出

```python
# training/scripts/export_to_ollama.py
import subprocess

def export_to_ollama(checkpoint_dir: str, model_name: str):
    """
    导出模型到Ollama
    
    Args:
        checkpoint_dir: 训练检查点目录
        model_name: Ollama模型名称
    """
    
    # 1. 合并LoRA权重
    print("合并LoRA权重...")
    subprocess.run([
        "llamafactory-cli", "export",
        "--model_name_or_path", "Qwen/Qwen2.5-7B-Instruct",
        "--adapter_name_or_path", checkpoint_dir,
        "--export_dir", f"training/models/{model_name}-merged"
    ])
    
    # 2. 转换为GGUF格式（量化）
    print("转换为GGUF格式...")
    subprocess.run([
        "python", "llama.cpp/convert.py",
        f"training/models/{model_name}-merged",
        "--outtype", "q4_0",
        "--outfile", f"training/models/{model_name}.gguf"
    ])
    
    # 3. 创建Modelfile
    modelfile = f"""
FROM training/models/{model_name}.gguf
TEMPLATE \"\"\"{{ .System }}
User: {{ .Prompt }}
Assistant:\"\"\"
PARAMETER temperature 0.1
PARAMETER top_p 0.8
PARAMETER stop "User:"
PARAMETER stop "Assistant:"
"""
    
    with open(f"training/models/{model_name}.Modelfile", "w") as f:
        f.write(modelfile)
    
    # 4. 导入到Ollama
    print(f"导入到Ollama: {model_name}")
    subprocess.run([
        "ollama", "create", model_name,
        "-f", f"training/models/{model_name}.Modelfile"
    ])
    
    print(f"✅ 模型已导入Ollama: {model_name}")
    print(f"使用命令测试: ollama run {model_name}")
```

---

## 六、增量训练

### 6.1 增量训练触发

```python
# services/incremental_trainer.py
from celery import Celery

app = Celery('training', broker='redis://localhost:6379/0')

@app.task
def trigger_incremental_training():
    """触发增量训练任务"""
    
    # 1. 导出新增数据
    export_training_data("resume_parse", "training/datasets/incremental")
    
    # 2. 合并到主数据集
    merge_datasets(
        "training/datasets/processed/resume_parse_train.jsonl",
        "training/datasets/incremental/resume_parse_train.jsonl",
        "training/datasets/processed/resume_parse_train_v2.jsonl"
    )
    
    # 3. 启动微调任务
    finetune_qwen(
        config_path="training/configs/qwen_resume_v2.yaml",
        experiment_name="resume-parsing-incremental"
    )
    
    # 4. 自动部署新模型（可选）
    if auto_deploy_enabled():
        export_to_ollama(
            "training/checkpoints/qwen-resume-v2",
            "qwen-resume-v2"
        )
        
        # 通知Java服务切换模型
        notify_java_service_model_update("qwen-resume-v2")
```

### 6.2 A/B测试

```python
# services/ab_testing.py
import random

class ModelRouter:
    """模型路由器（A/B测试）"""
    
    def __init__(self):
        self.models = {
            "v1": {"name": "qwen-resume-v1", "traffic": 0.5},
            "v2": {"name": "qwen-resume-v2", "traffic": 0.5}
        }
    
    def route(self, user_id: str) -> str:
        """根据用户ID路由到不同模型版本"""
        
        # 一致性哈希，保证同一用户总是路由到同一模型
        hash_value = hash(user_id) % 100
        
        cumulative = 0
        for version, config in self.models.items():
            cumulative += config["traffic"] * 100
            if hash_value < cumulative:
                return config["name"]
        
        return self.models["v1"]["name"]  # 默认
```

---

## 七、效果监控

### 7.1 指标采集

```python
# services/metrics_collector.py
class MetricsCollector:
    """指标采集器"""
    
    def log_inference(self, model_version: str, task_type: str,
                     duration: float, score: float, user_feedback: str = None):
        """记录推理指标"""
        
        MySQLClient().insert("ai_metrics", {
            "model_version": model_version,
            "task_type": task_type,
            "duration_ms": int(duration * 1000),
            "score": score,
            "user_feedback": user_feedback,
            "created_at": datetime.now()
        })
```

### 7.2 效果对比报表

```sql
-- 对比不同模型版本的效果
SELECT 
    model_version,
    COUNT(*) as total_count,
    AVG(score) as avg_score,
    AVG(duration_ms) as avg_duration,
    SUM(CASE WHEN user_feedback = 'correct' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as user_satisfaction
FROM ai_metrics
WHERE task_type = 'resume_parse'
  AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY model_version
ORDER BY model_version;
```

---

## 八、完整流程示例

### 简历解析模型从0到1

```bash
# 阶段1：数据积累（第1个月）
# - 使用智谱API处理1000份简历
# - 自动保存所有输入输出
# - HR修正100+条样本

# 阶段2：数据准备（第2个月初）
cd training

# 导出训练数据
python scripts/export_training_data.py --task resume_parse --output datasets/raw

# 数据清洗
python scripts/clean_dataset.py --input datasets/raw --output datasets/processed

# 质量检查
python scripts/validate_dataset.py --input datasets/processed/resume_parse_train.jsonl

# 阶段3：模型微调（第2个月中）
# 配置训练参数
vim configs/qwen_resume_v1.yaml

# 开始训练
python scripts/finetune_qwen.py \
  --config configs/qwen_resume_v1.yaml \
  --experiment resume-parsing-v1

# 阶段4：模型评估
python scripts/evaluate_model.py \
  --checkpoint checkpoints/qwen-resume-v1 \
  --test-data datasets/processed/resume_parse_test.jsonl

# 阶段5：模型部署（第2个月末）
python scripts/export_to_ollama.py \
  --checkpoint checkpoints/qwen-resume-v1 \
  --model-name qwen-resume

# 验证模型
ollama run qwen-resume "解析这份简历: 张三，13800138000..."

# 阶段6：上线A/B测试
# 修改配置文件，让50%流量走新模型
vim ../recruit-ai-service/config/settings.py

# 阶段7：效果监控（持续）
# 查看MLflow UI
mlflow ui --port 5000

# 查看数据库指标
mysql -e "SELECT * FROM ai_metrics WHERE model_version = 'qwen-resume-v1' LIMIT 10;"
```

---

## 九、学习资源

### 推荐工具

- **LLaMA-Factory**: https://github.com/hiyouga/LLaMA-Factory
- **Ollama**: https://ollama.com/
- **MLflow**: https://mlflow.org/

### 推荐课程

- HuggingFace NLP Course: https://huggingface.co/learn/nlp-course
- LangChain Academy: https://academy.langchain.com/

---

## 相关文档

- [AI能力集成架构](./ai-integration-architecture.md)

> ⚠️ 本文与 `ai-integration-architecture.md` 同属**尚未实装的域**，不是系统现状。
>
> 以下文档**尚未撰写**（勿按链接查找）：`data-annotation-guidelines.md`（数据标注规范）。

- [Java-Python集成规范](../conventions/java-python-integration.md)
