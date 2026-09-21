package com.recruit.vo;

import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 候选人列表项（中台「候选人库」页展示用）。
 *
 * <p>ID 用 String 传输：雪花 ID 超出 JS 安全整数范围（沿用 PublishRecordVO 口径）。</p>
 */
@Data
@Builder
public class CandidateVO {

    private String id;

    private String platform;

    private String platformUserId;

    /**
     * 同一人的另一种 ID 形态（BOSS 数字 uid ↔ 加密 geekId）。
     *
     * <p>透出给中台是为了让「归一是否生效」肉眼可验：采集端两种 ID 形态都该落到同一行，
     * 界面上能看到两个键，就不用去翻库确认了。NULL = 尚未学到另一种形态。</p>
     */
    private String platformUserIdAlt;

    private String name;

    private String currentTitle;

    private String expectSalary;

    private String city;

    private String education;

    private String school;

    private String major;

    private String workYear;

    private String age;

    /** 1 男 2 女 0/NULL 未知 */
    private Integer gender;

    /** 首次采集来源渠道：chat 候选人主动来 / recommend 我方主动发 */
    private String sourceChannel;

    private Integer versionCount;

    private Integer attachmentCount;

    /** 非空表示该候选人已被归并到 mergedIntoId（列表默认不展示已合并行） */
    private String mergedIntoId;

    private LocalDateTime firstCollectedAt;

    private LocalDateTime lastCollectedAt;
}
