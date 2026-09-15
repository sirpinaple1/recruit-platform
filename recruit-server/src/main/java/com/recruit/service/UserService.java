package com.recruit.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.recruit.common.JwtUtil;
import com.recruit.common.MyException;
import com.recruit.dto.LoginDTO;
import com.recruit.entity.SysUser;
import com.recruit.mapper.SysUserMapper;
import com.recruit.vo.LoginVO;
import lombok.RequiredArgsConstructor;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

/**
 * 用户与登录
 */
@RequiredArgsConstructor
@Service
public class UserService {

    private final SysUserMapper sysUserMapper;
    private final JwtUtil jwtUtil;

    /** BCrypt 校验器无状态，直接持有 */
    private final BCryptPasswordEncoder passwordEncoder = new BCryptPasswordEncoder();

    public LoginVO login(LoginDTO dto) {
        SysUser user = sysUserMapper.selectOne(
                new LambdaQueryWrapper<SysUser>().eq(SysUser::getUsername, dto.getUsername()));
        // 用户不存在与密码错误统一提示，避免账号枚举
        if (user == null || !passwordEncoder.matches(dto.getPassword(), user.getPassword())) {
            throw new MyException(401, "用户名或密码错误");
        }
        if (!"active".equals(user.getStatus())) {
            throw new MyException(403, "账号已停用");
        }
        return LoginVO.builder()
                .token(jwtUtil.generate(user.getId(), user.getUsername()))
                .id(user.getId())
                .username(user.getUsername())
                .realName(user.getRealName())
                .role(user.getRole())
                .build();
    }

    public SysUser getById(Long id) {
        return sysUserMapper.selectById(id);
    }
}
