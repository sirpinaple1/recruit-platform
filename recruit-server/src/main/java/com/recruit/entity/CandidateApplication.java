package com.recruit.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 候选人投递事实（人 × 平台岗位），见 {@code sql/candidate_application_create_20260922_V1.sql}。
 *
 * <p>与 {@link Candidate} / {@link ResumeVersion} 的分工：Candidate 是<b>人的主体</b>，
 * ResumeVersion 是<b>同一人简历的多个快照</b>，本表记录的是<b>行为</b>——
 * 「这个人对平台上的哪个岗位产生了投递」。同一个人可以投多个岗位（1:N），
 * 所以不能塞进 Candidate 的一个列里（那还会撞上「只补空不覆盖」的语义，把第二次投递吞掉）。</p>
 *
 * <p><b>幂等键：platform + candidateId + platformJobId</b>（唯一）。刻意<b>不含</b> appliedAt：
 * 投递时间是首次观测时刻，重复采集不得改写它，否则「第一次投递时间」会因子行更新而漂移。</p>
 *
 * <p><b>requestId 是派生快照，不是事实。</b>它由 (platform, platformJobId) 经
 * {@code publish_record.platform_job_id} 映射解析而来；映射未建立时为 {@code null}，
 * 建立后由 {@code CandidateApplicationService} 批量重算补齐。
 * 因此人工改绑映射时是<b>级联重算</b>而不是改历史——数据只有一个真源。</p>
 *
 * <p>红线：本表不含 PII（无姓名/手机号/邮箱），只有 ID 与平台原文提示文本。</p>
 */
@Data
@TableName("candidate_application")
public class CandidateApplication {

    @TableId(type = IdType.ASSIGN_ID)
    private Long id;

    /** 候选人 candidate.id */
    private Long candidateId;

    /** 平台标识，取值口径同 channel.code（如 boss） */
    private String platform;

    /**
     * 平台侧岗位 ID（BOSS jobId）。
     *
     * <p><b>NOT NULL</b> 是刻意的：只有真正拿到了岗位 ID 才有资格落一行。
     * 若允许为空，就会出现「投递但不知道投了哪个岗」的半行数据，
     * 反而让「哪些候选人还没归类」无法用「表里没有行」来判定。</p>
     */
    private String platformJobId;

    /**
     * 平台原文岗位线索（如 {@code 9月21日 沟通的职位-Java}）—— <b>仅供人工辨认</b>。
     *
     * <p>它是「沟通日期 + 职位名」的拼接文本，不是干净岗位名，且日期会变。
     * 绝不拿它去匹配 {@code hr_request.title}（标题是人工两次输入，必然漂移）。</p>
     */
    private String platformJobHint;

    /** 派生快照：映射解析出的 hr_request.id；映射未建立时为 null */
    private Long requestId;

    /** 采集来源渠道：chat 候选人主动来 / recommend 我方主动发 */
    private String sourceChannel;

    /** 首次落该投递时对应的简历版本 resume_version.id（追溯来源用，非外键） */
    private Long firstResumeVersionId;

    /** 投递时刻（UTC）：取自简历版本 collected_at，非入库时刻；重复采集不改写 */
    private LocalDateTime appliedAt;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
