package com.recruit.vo;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

/**
 * 扩展 session-token 响应（零配置授权，见 channel-publish-seamless.md §4.1）
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ExtensionSessionTokenVO {

    /**
     * token 明文（仅新签发时有值，复用时为 null）
     */
    private String token;

    /**
     * 是否复用现有 token
     */
    private Boolean reused;

    /**
     * token ID（String 形式）
     */
    private String tokenId;

    /**
     * 过期时间（UTC）
     */
    private LocalDateTime expiresAt;
}
