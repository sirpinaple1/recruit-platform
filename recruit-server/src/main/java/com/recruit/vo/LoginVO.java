package com.recruit.vo;

import lombok.Builder;
import lombok.Data;

/**
 * 登录结果 / 当前用户信息
 */
@Data
@Builder
public class LoginVO {

    private String token;

    private Long id;

    private String username;

    private String realName;

    /** ADMIN / HR / INTERVIEWER */
    private String role;
}
