package com.recruit.event;

/**
 * 新简历版本落库事件（采集事务提交后由 {@code ResumeScoreService} 异步消费，触发 LLM 打分）。
 *
 * <p>只在<b>新建版本</b>时发布 —— 版本去重跳过（内容相同）不发布，
 * 天然保证「同一份简历内容不会重复打分」。</p>
 *
 * <p>只带两个 ID，消费侧自行回查候选人/投递/需求单：
 * 事件携带越少，监听方对当时上下文的依赖越少，手动重打与事件触发才能复用同一条代码路径。</p>
 */
public record ResumeVersionCreatedEvent(Long candidateId, Long resumeVersionId) {
}
