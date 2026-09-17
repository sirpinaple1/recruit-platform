package com.recruit.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.recruit.common.MyException;
import com.recruit.entity.ExtensionToken;
import com.recruit.entity.SysUser;
import com.recruit.mapper.ExtensionTokenMapper;
import com.recruit.mapper.SysUserMapper;
import com.recruit.vo.ExtensionTokenCreatedVO;
import com.recruit.vo.ExtensionSessionTokenVO;
import com.recruit.vo.ExtensionTokenVO;
import lombok.RequiredArgsConstructor;
import lombok.extern.log4j.Log4j2;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 扩展授权（见设计文档 §5.5）：
 * - token 明文仅创建响应返回一次，库中只存 SHA-256 hash（红线：不落库不落日志）；
 * - verify 供扩展端拦截器调用：hash 命中且 active 才放行，并刷新 last_used_at；
 * - 权限语义最小化：扩展 token 仅可拉 pending 草稿与回填 record。
 */
@Log4j2
@RequiredArgsConstructor
@Service
public class ExtensionTokenService {

    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    private final ExtensionTokenMapper extensionTokenMapper;
    private final SysUserMapper sysUserMapper;

    /** 生成授权：随机 256-bit token（Base64URL），SHA-256 hex 落库，明文一次性返回 */
    public ExtensionTokenCreatedVO create(String name, Long userId) {
        byte[] bytes = new byte[32];
        SECURE_RANDOM.nextBytes(bytes);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        String hash = sha256Hex(token);

        ExtensionToken entity = new ExtensionToken();
        entity.setTokenHash(hash);
        entity.setName(name);
        entity.setUserId(userId);
        entity.setStatus("active");
        extensionTokenMapper.insert(entity);

        SysUser user = sysUserMapper.selectById(userId);
        log.info("扩展授权创建：id={}, name={}, user={}", entity.getId(), name, userId);
        // 回查拿 DB 生成的 created_at（insert 不会回填默认值）
        ExtensionToken saved = extensionTokenMapper.selectById(entity.getId());
        return ExtensionTokenCreatedVO.builder()
                .id(String.valueOf(saved.getId()))
                .name(saved.getName())
                .token(token)
                .tokenHashPrefix(saved.getTokenHash().substring(0, 12))
                .userName(user == null ? null : user.getRealName())
                .createdAt(saved.getCreatedAt())
                .build();
    }

    /** 列表：只暴露 hash 前缀与元数据（关联用户名） */
    public List<ExtensionTokenVO> list() {
        List<ExtensionToken> tokens = extensionTokenMapper.selectList(
                new LambdaQueryWrapper<ExtensionToken>().orderByDesc(ExtensionToken::getId));
        if (tokens.isEmpty()) {
            return List.of();
        }
        Map<Long, SysUser> userById = sysUserMapper.selectBatchIds(
                        tokens.stream().map(ExtensionToken::getUserId).distinct().toList())
                .stream().collect(Collectors.toMap(SysUser::getId, Function.identity()));
        return tokens.stream()
                .map(t -> ExtensionTokenVO.from(t,
                        userById.get(t.getUserId()) == null ? null : userById.get(t.getUserId()).getRealName()))
                .toList();
    }

    /** 吊销：active -> revoked，写 revoked_at；吊销后扩展端请求立即 401 */
    public ExtensionTokenVO revoke(Long id) {
        ExtensionToken entity = requireById(id);
        if (!"active".equals(entity.getStatus())) {
            throw new MyException(400, "该授权已被吊销");
        }
        extensionTokenMapper.update(null, new LambdaUpdateWrapper<ExtensionToken>()
                .eq(ExtensionToken::getId, id)
                .set(ExtensionToken::getStatus, "revoked")
                .set(ExtensionToken::getRevokedAt, LocalDateTime.now(ZoneOffset.UTC)));
        log.info("扩展授权吊销：id={}", id);
        SysUser user = sysUserMapper.selectById(entity.getUserId());
        return ExtensionTokenVO.from(extensionTokenMapper.selectById(id),
                user == null ? null : user.getRealName());
    }

    /**
     * 零配置授权：登录态换权（复用或新签发）
     * 
     * @param userId 当前登录用户
     * @param oldToken 扩展本地已有 token（可选）
     * @return 复用或新签发的 token 信息
     */
    public ExtensionSessionTokenVO resolveForSession(Long userId, String oldToken) {
        if (StringUtils.hasText(oldToken)) {
            String hash = sha256Hex(oldToken.trim());
            ExtensionToken existing = extensionTokenMapper.selectOne(new LambdaQueryWrapper<ExtensionToken>()
                    .eq(ExtensionToken::getTokenHash, hash)
                    .eq(ExtensionToken::getStatus, "active")
                    .eq(ExtensionToken::getUserId, userId)
                    .last("LIMIT 1"));
            
            if (existing != null) {
                log.info("扩展授权复用：id={}, user={}", existing.getId(), userId);
                extensionTokenMapper.update(null, new LambdaUpdateWrapper<ExtensionToken>()
                        .eq(ExtensionToken::getId, existing.getId())
                        .set(ExtensionToken::getLastUsedAt, LocalDateTime.now(ZoneOffset.UTC)));
                
                return ExtensionSessionTokenVO.builder()
                        .token(null)
                        .reused(true)
                        .tokenId(String.valueOf(existing.getId()))
                        .expiresAt(null)
                        .build();
            }
        }
        
        ExtensionTokenCreatedVO created = create("session-auto-" + System.currentTimeMillis(), userId);
        log.info("扩展授权新签发：id={}, user={}", created.getId(), userId);
        
        return ExtensionSessionTokenVO.builder()
                .token(created.getToken())
                .reused(false)
                .tokenId(created.getId())
                .expiresAt(null)
                .build();
    }

    /**
     * 扩展端鉴权校验：按明文 token 的 SHA-256 查 active 授权。
     * 命中返回实体（拦截器挂 userId）；miss 返回 null（拦截器回 401）。
     * 通过时同步刷新 last_used_at。
     */
    public ExtensionToken verify(String rawToken) {
        if (!StringUtils.hasText(rawToken)) {
            return null;
        }
        ExtensionToken entity = extensionTokenMapper.selectOne(new LambdaQueryWrapper<ExtensionToken>()
                .eq(ExtensionToken::getTokenHash, sha256Hex(rawToken.trim()))
                .eq(ExtensionToken::getStatus, "active")
                .last("LIMIT 1"));
        if (entity == null) {
            return null;
        }
        extensionTokenMapper.update(null, new LambdaUpdateWrapper<ExtensionToken>()
                .eq(ExtensionToken::getId, entity.getId())
                .set(ExtensionToken::getLastUsedAt, LocalDateTime.now(ZoneOffset.UTC)));
        return entity;
    }

    private ExtensionToken requireById(Long id) {
        ExtensionToken entity = extensionTokenMapper.selectById(id);
        if (entity == null) {
            throw new MyException(404, "扩展授权不存在");
        }
        return entity;
    }

    private String sha256Hex(String raw) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(raw.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16));
                hex.append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            // JDK 必带 SHA-256，不可达
            throw new IllegalStateException(e);
        }
    }
}
