package com.recruit.vo;

import com.recruit.entity.ExtensionToken;
import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 扩展授权列表项：只暴露 hash 前缀与元数据，明文 token 永不出现（红线 §5.5）。
 */
@Data
@Builder
public class ExtensionTokenVO {

    private String id;

    private String name;

    /** hash 前 12 位（辨识用，不可反推明文） */
    private String tokenHashPrefix;

    /** active/revoked */
    private String status;

    private String userName;

    private LocalDateTime lastUsedAt;

    private LocalDateTime revokedAt;

    private LocalDateTime createdAt;

    public static ExtensionTokenVO from(ExtensionToken t, String userName) {
        return ExtensionTokenVO.builder()
                .id(t.getId() == null ? null : String.valueOf(t.getId()))
                .name(t.getName())
                .tokenHashPrefix(t.getTokenHash() == null ? null : t.getTokenHash().substring(0, 12))
                .status(t.getStatus())
                .userName(userName)
                .lastUsedAt(t.getLastUsedAt())
                .revokedAt(t.getRevokedAt())
                .createdAt(t.getCreatedAt())
                .build();
    }
}
