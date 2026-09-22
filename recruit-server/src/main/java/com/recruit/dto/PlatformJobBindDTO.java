package com.recruit.dto;

import jakarta.validation.constraints.Size;
import lombok.Data;

/**
 * 人工绑定平台岗位（路径 B，见设计文档 candidate-position-linking.md）。
 *
 * <p>用途：把一条发布台账关联到平台上的具体岗位（BOSS jobId），从而让该岗位下
 * 采集回来的候选人投递能被归类到正确的需求单。</p>
 *
 * <p><b>为什么需要它</b>：路径 A（扩展在发布成功时自动捕获）依赖平台把岗位 ID
 * 暴露给页面，这一点无法保证（BOSS 发布页的岗位 ID 可见性未经验证）。
 * 没有人工出口的话，A 一旦捕获失败，映射就永久为空，投递永远归不了类 ——
 * 所以 B 不是「备选方案」，而是 A 的必要兜底。</p>
 *
 * <p><b>关于空值</b>：{@code platformJobId} 留空表示<b>解除绑定</b>。
 * 这是刻意的：自动捕获可能捕到一个错的岗位，此时 HR 需要能把错误值清掉
 * （清掉后投递回落为「未归类」，是可见状态），而不是被逼着填一个替代值。</p>
 */
@Data
public class PlatformJobBindDTO {

    /**
     * 平台侧岗位 ID（BOSS jobId）。空/null = 解除绑定。
     *
     * <p>不校验格式：不同平台的岗位 ID 形态不同（数字 / 加密串 / 带前缀），
     * 在 DTO 层写死规则会把「平台新增一种形态」变成一次后端发版。
     * 格式是否合理由人判断 —— 这本就是个人工动作，误填由 <b>唯一键 + 级联重算</b>
     * 兜住（绑错会立刻在候选人库的「投递职位」上看见，且可再改）。</p>
     */
    @Size(max = 64, message = "平台岗位 ID 不能超过 64 字")
    private String platformJobId;
}
