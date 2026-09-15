package com.recruit.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 扩展授权（浏览器扩展独立鉴权，见设计文档 §5.5）
 * 明文 token 仅创建时返回一次；库中只存 SHA-256 hash。
 */
@Data
@TableName("extension_token")
public class ExtensionToken {

    @TableId(type = IdType.ASSIGN_ID)
    private Long id;

    /** SHA-256(token) 十六进制 */
    private String tokenHash;

    /** 授权名称（如：HR张三的浏览器扩展） */
    private String name;

    /** 关联 sys_user.id（operated_by 来源） */
    private Long userId;

    /** active/revoked */
    private String status;

    private LocalDateTime lastUsedAt;

    private LocalDateTime revokedAt;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
