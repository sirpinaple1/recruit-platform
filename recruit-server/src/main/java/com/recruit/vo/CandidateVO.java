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

    /**
     * 投递记录数（该候选人一共投了几个平台岗位）。
     *
     * <p>0 = 采集到的响应里没有岗位线索（或岗位 ID 尚未捕获），该候选人还没被归类。</p>
     */
    private Integer applicationCount;

    /**
     * 最近一次投递解析出的需求单 ID；{@code null} 表示<b>尚未归类</b>。
     *
     * <p>null 有两种成因，且都有明确出口：① 该投递的平台岗位还没建立映射
     * （HR 到台账页绑定即可，路径 B）；② 该候选人压根没有投递事实
     * （{@code sourceChannel=recommend}，我方主动发的，本来就没投岗）。</p>
     */
    private String requestId;

    /** 最近一次投递对应的岗位名称（取自 hr_request.title，便于列表直接看懂） */
    private String requestTitle;

    /**
     * 最近一次投递的平台岗位 ID（BOSS jobId）。
     *
     * <p>透出给中台的理由同 {@link #platformUserIdAlt}：</p>
     * <p>让「采集到底有没有拿到岗位」肉眼可验 —— 有值说明平台响应里有、
     * 无值说明这条链路该修了，不必去翻 {@code resume_version.fields_json}。</p>
     */
    private String platformJobId;

    /**
     * 平台原文岗位线索（如「9月21日 沟通的职位-Java」）—— <b>仅供人工辨认</b>。
     *
     * <p>当 {@link #requestId} 为空、需要用路径 B 手工认领时，HR 就是靠这个文本
     * 判断「这条投递对应哪个岗位」的。它不参与任何自动判定（是拼接文本，会漂移）。</p>
     */
    private String platformJobHint;

    /** 非空表示该候选人已被归并到 mergedIntoId（列表默认不展示已合并行） */
    private String mergedIntoId;

    /** 最新一次成功打分的总分 0-100；null = 尚无成功打分（未打/打分中/失败） */
    private Integer latestScore;

    /** 最新一次成功打分的类型：match = 与需求单匹配 / general = 通用分析 */
    private String latestScoreType;

    /** 最新一次成功打分的推荐结论：recommend / maybe / not_recommend */
    private String latestRecommendation;

    private LocalDateTime firstCollectedAt;

    private LocalDateTime lastCollectedAt;
}
