package com.recruit.vo;

import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 扩展授权创建响应：含一次性明文 token（仅此一次，前端需立即让用户保存）。
 */
@Data
@Builder
public class ExtensionTokenCreatedVO {

    private String id;

    private String name;

    /** 明文 token：仅在创建响应出现一次，不落库不落日志（红线 §5.5） */
    private String token;

    private String tokenHashPrefix;

    private String userName;

    private LocalDateTime createdAt;
}
