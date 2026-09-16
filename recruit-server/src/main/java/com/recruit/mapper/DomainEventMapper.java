package com.recruit.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.recruit.entity.DomainEvent;
import org.apache.ibatis.annotations.Mapper;

/**
 * 领域事件 Mapper（append-only：只应有 insert/select 调用）
 */
@Mapper
public interface DomainEventMapper extends BaseMapper<DomainEvent> {
}
