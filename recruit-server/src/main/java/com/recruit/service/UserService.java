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
        LoginVO vo = toLoginVO(user);
        // token 只在登录时签发；/me 复用同一个 VO 但不重新签发（否则等于无限续期，绕过过期）
        vo.setToken(jwtUtil.generate(user.getId(), user.getUsername()));
        return vo;
    }

    /**
     * 当前登录用户信息（前端启动时用它判断会话是否仍可用）。
     *
     * <p>这里自己再判一次账号停用，不依赖 {@code RoleInterceptor}：后者已覆盖所有 Controller
     * 端点，但会话有效性属于本方法的语义，授权层只是兜底——两层都判，任何一层被绕过都不至于放行。</p>
     */
    public LoginVO me(Long userId) {
        SysUser user = userId == null ? null : sysUserMapper.selectById(userId);
        if (user == null) {
            throw new MyException(401, "用户不存在");
        }
        if (!"active".equals(user.getStatus())) {
            throw new MyException(403, "账号已停用");
        }
        // 不签发 token：本接口是读会话状态，不是登录
        return toLoginVO(user);
    }

    public SysUser getById(Long id) {
        return sysUserMapper.selectById(id);
    }

    private LoginVO toLoginVO(SysUser user) {
        return LoginVO.builder()
                .id(user.getId())
                .username(user.getUsername())
                .realName(user.getRealName())
                .role(user.getRole())
                .build();
    }
}
