package com.recruit.service;

import com.alibaba.fastjson2.JSONObject;
import com.recruit.common.DomainEventTypes;
import com.recruit.entity.DomainEvent;
import com.recruit.mapper.DomainEventMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.log4j.Log4j2;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.ZoneOffset;

/**
 * 领域事件写入（append-only，见 P1-2）。
 *
 * <p><b>为什么是同步写而不是发 MQ</b>：本期渠道与需求单量都很小，异步化的收益抵不过
 * 「引入中间件 + 事件最终一致」的复杂度（设计文档 §10 已把 RabbitMQ 异步化列为后置）。
 * 同步写在同一事务里反而更强：状态与事件原子提交，不存在「状态变了但事件丢了」。</p>
 *
 * <p><b>为什么不提供 update/delete</b>：事件流水的价值全部建立在「不可篡改」上。
 * 需要修正历史口径时应该追加一条更正事件，而不是改旧行。</p>
 */
@Log4j2
@RequiredArgsConstructor
@Service
public class DomainEventService {

    private final DomainEventMapper domainEventMapper;

    /**
     * 记录一次人力需求单状态转移。
     *
     * <p>事务传播为 REQUIRED（默认）：调用方已有事务时加入之，因此状态变更与事件
     * 必然一起提交或一起回滚——不会留下「有事件无状态」或「有状态无事件」的中间态。</p>
     *
     * @param eventType 取值见 {@link DomainEventTypes}
     * @param requestNo 仅作可读性冗余写入 payload；传 null 则不写 payload
     * @param operatorId 操作人；系统触发时记录触发者，确实无操作人时传 null
     */
    @Transactional(rollbackFor = Exception.class)
    public void hrRequestTransition(String eventType, Long requestId, String requestNo,
                                    String fromStatus, String toStatus, Long operatorId) {
        DomainEvent event = new DomainEvent();
        event.setEventType(eventType);
        event.setAggregateType(DomainEventTypes.AGGREGATE_HR_REQUEST);
        event.setAggregateId(requestId);
        event.setFromStatus(fromStatus);
        event.setToStatus(toStatus);
        event.setOperatorId(operatorId);
        event.setOccurredAt(LocalDateTime.now(ZoneOffset.UTC));
        if (requestNo != null) {
            // 用 JSON 构造器而非字符串拼接：需求编号虽由服务端生成、当前无特殊字符，
            // 但拼 JSON 是把转义正确性押在「将来也一直无特殊字符」上，没必要。
            JSONObject payload = new JSONObject();
            payload.put("requestNo", requestNo);
            event.setPayloadJson(payload.toJSONString());
        }
        domainEventMapper.insert(event);
        log.debug("领域事件 {}：request={} {} -> {} operator={}",
                eventType, requestNo, fromStatus, toStatus, operatorId);
    }
}
