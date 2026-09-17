package com.recruit.body;

import lombok.Data;

/**
 * 扩展 session-token 请求体（零配置授权，见 channel-publish-seamless.md §4.1）
 */
@Data
public class ExtensionSessionTokenBody {

    /**
     * 扩展本地已有的 token（可选）
     * 用于复用判定：若该 token 仍然 active 且属于当前用户，则复用；否则签发新 token
     */
    private String token;
}
