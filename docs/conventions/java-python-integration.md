# Java-Python 服务集成规范

> 本文档定义 recruit-server (Java) 与 recruit-ai-service (Python) 之间的通信规范

---

## 一、通信模式

### 1.1 同步调用（HTTP）

**适用场景**：
- HR手动触发的实时操作（如重新解析简历）
- 需要立即返回结果的场景（如简历评分）
- 超时时间可控（< 30s）

**Java端实现**：

```java
// com/recruit/service/AIService.java
package com.recruit.service;

import lombok.extern.log4j.Log4j2;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.multipart.MultipartFile;
import com.recruit.dto.ResumeParseRequest;
import com.recruit.vo.ResumeParseResult;

@Log4j2
@Service
public class AIService {
    
    @Value("${ai.service.url}")
    private String aiServiceUrl;
    
    private final RestTemplate restTemplate;
    
    public AIService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }
    
    /**
     * 同步解析简历
     * @param file 简历文件
     * @param jobId 职位ID
     * @return 解析结果
     */
    public ResumeParseResult parseResumeSync(MultipartFile file, Long jobId) {
        try {
            String url = aiServiceUrl + "/api/v1/resume/parse";
            
            ResumeParseRequest request = new ResumeParseRequest();
            request.setFile(file);
            request.setJobId(jobId);
            
            ResumeParseResult result = restTemplate.postForObject(
                url,
                request,
                ResumeParseResult.class
            );
            
            log.info("简历解析成功, jobId={}, score={}", jobId, result.getScore());
            return result;
            
        } catch (Exception e) {
            log.error("简历解析失败", e);
            throw new MyException("简历解析失败: " + e.getMessage());
        }
    }
}
```

**Python端实现**：

```python
# recruit-ai-service/routers/resume.py
from fastapi import APIRouter, UploadFile, Form
from pydantic import BaseModel

router = APIRouter(prefix="/api/v1/resume", tags=["简历"])

class ResumeParseResult(BaseModel):
    name: str
    phone: str
    email: str
    education: list
    work_experience: list
    skills: list
    score: float

@router.post("/parse")
async def parse_resume(
    file: UploadFile,
    job_id: int = Form(...)
):
    """同步解析简历"""
    try:
        # 解析逻辑
        result = await resume_parser.parse(file, job_id)
        return ResumeParseResult(**result)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
```

### 1.2 异步调用（MQ）

**适用场景**：
- 候选人投递（不阻塞用户）
- 批量任务（如批量评分）
- 长时间任务（如模型训练）

**Java端实现**：

```java
// com/recruit/service/AIAsyncService.java
package com.recruit.service;

import lombok.extern.log4j.Log4j2;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.stereotype.Service;
import com.recruit.dto.ResumeParseTask;

@Log4j2
@Service
public class AIAsyncService {
    
    private final RabbitTemplate rabbitTemplate;
    
    public AIAsyncService(RabbitTemplate rabbitTemplate) {
        this.rabbitTemplate = rabbitTemplate;
    }
    
    /**
     * 异步解析简历
     * @param fileUrl 简历文件URL（MinIO）
     * @param applicationId 申请ID
     */
    public void parseResumeAsync(String fileUrl, Long applicationId) {
        ResumeParseTask task = new ResumeParseTask();
        task.setFileUrl(fileUrl);
        task.setApplicationId(applicationId);
        task.setTimestamp(System.currentTimeMillis());
        
        rabbitTemplate.convertAndSend(
            "ai.resume.parse.queue",
            task
        );
        
        log.info("简历解析任务已发送, applicationId={}", applicationId);
    }
}
```

**Python端消费者**：

```python
# recruit-ai-service/consumers/resume_consumer.py
import pika
import json
from services.resume_parser import ResumeParser
from services.minio_client import MinioClient
from services.result_notifier import ResultNotifier

def consume_resume_parse_tasks():
    """消费简历解析任务"""
    
    connection = pika.BlockingConnection(
        pika.ConnectionParameters('localhost')
    )
    channel = connection.channel()
    channel.queue_declare(queue='ai.resume.parse.queue', durable=True)
    
    def callback(ch, method, properties, body):
        try:
            task = json.loads(body)
            
            # 1. 从MinIO下载文件
            file_content = MinioClient().download(task['file_url'])
            
            # 2. 解析简历
            parser = ResumeParser()
            result = parser.parse(file_content)
            
            # 3. 回写结果到Java服务（通过HTTP）
            ResultNotifier().notify_parse_complete(
                task['application_id'],
                result
            )
            
            ch.basic_ack(delivery_tag=method.delivery_tag)
            
        except Exception as e:
            print(f"处理失败: {e}")
            ch.basic_nack(delivery_tag=method.delivery_tag, requeue=True)
    
    channel.basic_consume(
        queue='ai.resume.parse.queue',
        on_message_callback=callback
    )
    
    print('开始消费简历解析任务...')
    channel.start_consuming()
```

---

## 二、数据传输格式

### 2.1 请求格式

**简历解析请求**：

```json
POST /api/v1/resume/parse

Content-Type: multipart/form-data

{
  "file": <binary>,
  "job_id": 123,
  "parse_options": {
    "extract_photo": false,
    "ocr_enabled": true
  }
}
```

**简历评分请求**：

```json
POST /api/v1/resume/score

Content-Type: application/json

{
  "resume_id": 456,
  "job_id": 123,
  "resume_data": {
    "name": "张三",
    "education": [...],
    "work_experience": [...]
  },
  "job_requirements": {
    "education_level": "本科",
    "years_experience": 3,
    "required_skills": ["Java", "Spring"]
  }
}
```

### 2.2 响应格式

**成功响应**：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "name": "张三",
    "phone": "13800138000",
    "email": "zhangsan@example.com",
    "education": [
      {
        "school": "清华大学",
        "degree": "本科",
        "major": "计算机科学",
        "start_date": "2015-09",
        "end_date": "2019-06"
      }
    ],
    "work_experience": [...],
    "skills": ["Java", "Python", "MySQL"],
    "score": 0.85,
    "confidence": 0.92
  }
}
```

**错误响应**：

```json
{
  "code": 500,
  "message": "简历解析失败: 文件格式不支持",
  "data": null,
  "trace_id": "abc123def456"
}
```

---

## 三、错误处理

### 3.1 超时处理

**Java端配置**：

```java
// com/recruit/config/RestTemplateConfig.java
@Configuration
public class RestTemplateConfig {
    
    @Bean
    public RestTemplate restTemplate() {
        HttpComponentsClientHttpRequestFactory factory = 
            new HttpComponentsClientHttpRequestFactory();
        
        factory.setConnectTimeout(5000);      // 连接超时 5s
        factory.setReadTimeout(30000);        // 读取超时 30s
        
        return new RestTemplate(factory);
    }
}
```

**超时降级策略**：

```java
public ResumeParseResult parseResumeSync(MultipartFile file, Long jobId) {
    try {
        return restTemplate.postForObject(...);
    } catch (ResourceAccessException e) {
        // 超时，降级到异步处理
        log.warn("AI服务超时，降级到异步处理");
        parseResumeAsync(uploadToMinIO(file), applicationId);
        return createPendingResult();
    }
}
```

### 3.2 重试机制

**Java端重试配置**：

```java
@Retryable(
    value = {ResourceAccessException.class},
    maxAttempts = 3,
    backoff = @Backoff(delay = 1000, multiplier = 2)
)
public ResumeParseResult parseResumeWithRetry(MultipartFile file, Long jobId) {
    return parseResumeSync(file, jobId);
}
```

**Python端幂等性保证**：

```python
@router.post("/parse")
async def parse_resume(file: UploadFile, job_id: int, idempotency_key: str = Header(None)):
    """带幂等性的简历解析"""
    
    # 检查是否已处理过
    if idempotency_key:
        cached = redis_client.get(f"idempotency:{idempotency_key}")
        if cached:
            return json.loads(cached)
    
    # 执行解析
    result = await resume_parser.parse(file, job_id)
    
    # 缓存结果（24小时）
    if idempotency_key:
        redis_client.setex(
            f"idempotency:{idempotency_key}",
            86400,
            json.dumps(result)
        )
    
    return result
```

---

## 四、监控与日志

### 4.1 Java端日志

```java
@Log4j2
@Service
public class AIService {
    
    public ResumeParseResult parseResumeSync(MultipartFile file, Long jobId) {
        long startTime = System.currentTimeMillis();
        
        try {
            log.info("开始调用AI服务, jobId={}, filename={}", jobId, file.getOriginalFilename());
            
            ResumeParseResult result = restTemplate.postForObject(...);
            
            long duration = System.currentTimeMillis() - startTime;
            log.info("AI服务调用成功, jobId={}, duration={}ms, score={}", 
                jobId, duration, result.getScore());
            
            return result;
            
        } catch (Exception e) {
            long duration = System.currentTimeMillis() - startTime;
            log.error("AI服务调用失败, jobId={}, duration={}ms", jobId, duration, e);
            throw new MyException("AI服务调用失败");
        }
    }
}
```

### 4.2 Python端日志

```python
import logging
from fastapi import Request
import time

logger = logging.getLogger(__name__)

@router.post("/parse")
async def parse_resume(request: Request, file: UploadFile, job_id: int):
    """简历解析（带日志）"""
    start_time = time.time()
    
    try:
        logger.info(f"接收到简历解析请求, job_id={job_id}, filename={file.filename}")
        
        result = await resume_parser.parse(file, job_id)
        
        duration = time.time() - start_time
        logger.info(f"简历解析成功, job_id={job_id}, duration={duration:.2f}s, score={result['score']}")
        
        return result
        
    except Exception as e:
        duration = time.time() - start_time
        logger.error(f"简历解析失败, job_id={job_id}, duration={duration:.2f}s, error={str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
```

### 4.3 链路追踪

**Java端传递TraceId**：

```java
HttpHeaders headers = new HttpHeaders();
headers.add("X-Trace-Id", MDC.get("traceId"));
headers.add("X-Request-Id", UUID.randomUUID().toString());

HttpEntity<ResumeParseRequest> entity = new HttpEntity<>(request, headers);
restTemplate.exchange(url, HttpMethod.POST, entity, ResumeParseResult.class);
```

**Python端接收TraceId**：

```python
@router.post("/parse")
async def parse_resume(
    request: Request,
    file: UploadFile,
    job_id: int,
    x_trace_id: str = Header(None),
    x_request_id: str = Header(None)
):
    # 将trace_id传递到日志上下文
    with logger_context(trace_id=x_trace_id, request_id=x_request_id):
        result = await resume_parser.parse(file, job_id)
        return result
```

---

## 五、配置规范

### 5.1 Java端配置（application.yml）

```yaml
# application-dev.yml
ai:
  service:
    url: http://localhost:8000
    timeout:
      connect: 5000
      read: 30000
    retry:
      max-attempts: 3
      backoff-delay: 1000

# application-prod.yml
ai:
  service:
    url: http://recruit-ai-service:8000
    timeout:
      connect: 5000
      read: 30000
    retry:
      max-attempts: 3
      backoff-delay: 1000
```

### 5.2 Python端配置（.env）

```bash
# .env.dev
JAVA_SERVICE_URL=http://localhost:8080
MYSQL_HOST=localhost
MYSQL_PORT=3306
REDIS_HOST=localhost
REDIS_PORT=6379
MINIO_ENDPOINT=localhost:9000

# .env.prod
JAVA_SERVICE_URL=http://recruit-server:8080
MYSQL_HOST=mysql-service
MYSQL_PORT=3306
REDIS_HOST=redis-service
REDIS_PORT=6379
MINIO_ENDPOINT=minio-service:9000
```

---

## 六、接口清单

### 6.1 Python AI服务提供的接口

| 接口路径 | 方法 | 说明 | 调用方式 |
|---|---|---|---|
| `/api/v1/resume/parse` | POST | 简历解析 | 同步 |
| `/api/v1/resume/score` | POST | 简历评分 | 同步 |
| `/api/v1/job/generate-jd` | POST | 生成JD | 同步 |
| `/api/v1/talent/recommend` | POST | 人才推荐 | 同步 |
| `/api/v1/interview/generate-questions` | POST | 生成面试问题 | 同步 |
| `/api/v1/training/status` | GET | 模型训练状态 | 同步 |

### 6.2 Java服务提供给Python的回调接口

| 接口路径 | 方法 | 说明 | 调用方 |
|---|---|---|---|
| `/api/callback/resume-parsed` | POST | 简历解析完成回调 | Python |
| `/api/callback/training-complete` | POST | 模型训练完成回调 | Python |

---

## 七、最佳实践

### 7.1 Java端调用建议

1. ✅ 使用专门的 `AIService` 封装所有AI调用
2. ✅ 长时间任务优先使用异步（MQ）
3. ✅ 添加超时和重试机制
4. ✅ 记录详细日志（请求参数、响应结果、耗时）
5. ✅ 敏感数据不打印到日志

### 7.2 Python端实现建议

1. ✅ 使用 Pydantic 校验请求参数
2. ✅ 统一错误响应格式
3. ✅ 保证接口幂等性（使用idempotency key）
4. ✅ 长时间任务返回任务ID，提供查询接口
5. ✅ 添加健康检查接口 `/health`

### 7.3 性能优化建议

1. ✅ 文件上传使用流式传输
2. ✅ 大批量任务使用MQ削峰
3. ✅ 热点数据使用Redis缓存
4. ✅ 本地模型推理使用批处理（batch）
5. ✅ 定期清理过期的幂等性缓存

---

## 八、故障处理

### 8.1 AI服务不可用

**Java端降级策略**：

```java
public ResumeParseResult parseResume(MultipartFile file, Long jobId) {
    try {
        // 优先调用AI服务
        return aiService.parseResumeSync(file, jobId);
    } catch (Exception e) {
        log.warn("AI服务不可用，降级到规则引擎");
        // 降级到简单规则解析
        return fallbackParser.parse(file, jobId);
    }
}
```

### 8.2 MQ消息堆积

**监控指标**：
- 队列长度 > 1000：告警
- 消费速度 < 10条/s：告警

**处理方案**：
1. 扩容Python服务（增加消费者）
2. 优化解析性能（批处理、模型量化）
3. 临时关闭非核心功能（如JD生成）

---

## 相关文档

- [AI能力集成架构](../architecture/ai-integration-architecture.md)
- [架构总览](../architecture/overview.md) / [分层规则](../architecture/layer-structure.md)
- [ADR 索引](../architecture/adr/README.md)

> 以下文档**尚未撰写**（勿按链接查找）：
> - `coding-standards.md`（后端编码规范）—— 命名/异常/日志部分散见 `layer-structure.md`
> - `api-design.md`（API 设计规范）—— 目前只有 `overview.md` §请求链路 的片段
