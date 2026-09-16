package com.recruit.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 领域事件流水（append-only）
 *
 * <p>用途：为指标口径提供事件时间线——只 COUNT 当前行回答不了「上月审批通过多少」
 * 「平均审批耗时」，需要事件才能回答（见 P1-2）。</p>
 *
 * <p>写入约定：只 INSERT，不提供任何更新/删除路径；{@code payloadJson} 仅放内部
 * 标识类冗余，严禁写入候选人 PII（红线 3）。</p>
 */
@Data
@TableName("domain_event")
public class DomainEvent {

    @TableId(type = IdType.ASSIGN_ID)
    private Long id;

    /** <聚合>.<动作过去式>，如 hr_request.approved（取值见 DomainEventTypes） */
    private String eventType;

    private String aggregateType;

    private Long aggregateId;

    /** 转移前状态（状态机事件专有） */
    private String fromStatus;

    /** 转移后状态（状态机事件专有） */
    private String toStatus;

    /** 附加数据 JSON（可读性冗余） */
    private String payloadJson;

    /** 操作人 sys_user.id */
    private Long operatorId;

    /** 事件发生时刻（UTC） */
    private LocalDateTime occurredAt;

    private LocalDateTime createdAt;
}
