package com.recruit.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 候选人（采集主体，见 candidate_create 脚本头注释）。
 *
 * <p>幂等键：platform + platformUserId。<b>但同一个人在同一平台上会有不止一种 ID 形态</b>
 * （BOSS 的数字 uid 与加密 geekId），所以幂等必须按「主键 ∪ 备用键」查 —— 见
 * {@link #platformUserIdAlt}。同一候选人可能在多个平台、多次沟通中发来多份简历，
 * 归并为一个主体的多个简历版本，而不是多条重复记录。</p>
 *
 * <p>红线：phone_hash / email_hash 只存 SHA-256，手机号与邮箱原文永不落库。</p>
 */
@Data
@TableName("candidate")
public class Candidate {

    @TableId(type = IdType.ASSIGN_ID)
    private Long id;

    /** 来源平台标识，如 boss */
    private String platform;

    /**
     * 平台内候选人唯一 ID（规范键）。同一人的另一种 ID 形态见 {@link #platformUserIdAlt}。
     *
     * <p>取值规则：<b>新建时加密 ID 优先</b>（BOSS 的 encryptGeekId —— 附件下载端点的
     * 路径段用的就是它，附件与候选人因此在同一个标识下对齐）；只有数字 uid 时退而用数字 uid。
     * 已有行**不改写**本列 —— 首次落地形态即长期形态，避免动唯一键（见 CollectService 注释）。</p>
     */
    private String platformUserId;

    /**
     * 同一人在同一平台上的**另一种** ID 形态（备用键），参与幂等查找。
     *
     * <p>为什么需要这一列（2026-09-21 实测后果）：BOSS 聊天消息给数字 uid（`608120464`）、
     * 候选人卡片给加密 geekId（`01858de472ad39180XRy2t-9FFRU`），同一个人两个 ID 空间。
     * 旧实现只按 {@code platform_user_id} 单键查，于是「先采到数字、后采到加密」就分裂成两条
     * 候选人记录（陈诗健、谢建广各中一次）。备用键把这二次查找补上：任一形态都能落回同一行。</p>
     *
     * <p>与 {@link #sourcePlatformUserRaw} 的区别（别混用）：那个是「首次采集时的原始 ID 文本」，
     * 只写一次、纯对账用；本列是**活的查找键**，会随学习到的新形态补齐。</p>
     */
    private String platformUserIdAlt;

    private String name;

    /** 手机号 SHA-256 十六进制，跨平台归并键 */
    private String phoneHash;

    /** 邮箱 SHA-256 十六进制，跨平台归并键 */
    private String emailHash;

    private String currentTitle;

    private String expectSalary;

    private String city;

    private String education;

    private String school;

    private String major;

    /** 工作年限 / 届别描述 */
    private String workYear;

    /** 年龄（保留平台原文，如 23岁） */
    private String age;

    /** 1 男 2 女 0/NULL 未知 */
    private Integer gender;

    /** 首次采集来源：chat 候选人主动来 / recommend 我方主动发 */
    private String sourceChannel;

    private String sourcePlatformUserRaw;

    /** 归并目标 candidate.id；非空表示本条已被合并，查询需跟随（见 CandidateQueryService.detail） */
    private Long mergedInto;

    /** 冗余：简历版本数 */
    private Integer versionCount;

    private LocalDateTime firstCollectedAt;

    private LocalDateTime lastCollectedAt;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
