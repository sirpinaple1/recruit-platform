package com.recruit.controller;

import com.recruit.common.R;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 健康检查：DB / Redis 真实连通性
 */
@Slf4j
@RequiredArgsConstructor
@RestController
@RequestMapping("/api")
public class HealthController {

    private final JdbcTemplate jdbcTemplate;
    private final StringRedisTemplate stringRedisTemplate;

    @GetMapping("/health")
    public R<Map<String, String>> health() {
        Map<String, String> status = new LinkedHashMap<>();
        status.put("db", checkDb());
        status.put("redis", checkRedis());
        return R.ok(status);
    }

    private String checkDb() {
        try {
            Integer one = jdbcTemplate.queryForObject("SELECT 1", Integer.class);
            return one != null ? "ok" : "down";
        } catch (Exception e) {
            log.warn("DB 健康检查失败: {}", e.getMessage());
            return "down";
        }
    }

    private String checkRedis() {
        try {
            // 任意一次读操作即可证明连通与鉴权正常（键不存在返回 null 属正常）
            stringRedisTemplate.opsForValue().get("health:ping");
            return "ok";
        } catch (Exception e) {
            log.warn("Redis 健康检查失败: {}", e.getMessage());
            return "down";
        }
    }
}
