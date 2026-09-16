package com.recruit.controller;

import com.recruit.common.R;
import com.recruit.dto.LoginDTO;
import com.recruit.service.UserService;
import com.recruit.vo.LoginVO;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 登录与会话
 */
@RequiredArgsConstructor
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final UserService userService;

    /** 登录：返回 JWT */
    @PostMapping("/login")
    public R<LoginVO> login(@Valid @RequestBody LoginDTO dto) {
        return R.ok(userService.login(dto));
    }

    /** 当前登录用户信息 */
    @GetMapping("/me")
    public R<LoginVO> me(HttpServletRequest request) {
        return R.ok(userService.me((Long) request.getAttribute("userId")));
    }
}
