package com.recruit.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.ThreadPoolExecutor;

/**
 * 异步打分线程池。
 *
 * <p>LLM 打分一次几秒到几十秒，绝不能占采集请求线程（事件监听发生在
 * AFTER_COMMIT，此时 HTTP 响应还未返回）。专用小池 + 有界队列：
 * 采集本身是逐条人工触发的低频操作，正常水位远不到队列上限；
 * 真打满时 AbortPolicy 丢弃并记日志（打分可手动重打），不回压采集主流程。</p>
 */
@Configuration
@EnableAsync
public class AsyncConfig {

    @Bean("resumeScoreExecutor")
    public ThreadPoolTaskExecutor resumeScoreExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(2);
        executor.setMaxPoolSize(4);
        executor.setQueueCapacity(200);
        executor.setThreadNamePrefix("resume-score-");
        // 队列满时丢弃新任务：打分是尽力而为的增强能力，失败可手动重打，不能拖死采集
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
        executor.initialize();
        return executor;
    }
}
