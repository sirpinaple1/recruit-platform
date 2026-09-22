package com.recruit.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.Data;

/**
 * 扩展端台账回填（见设计文档 §6.2）。
 * status=published 时建议回填 publishedUrl；failed 时建议回填 resultNote。
 *
 * <p>{@link #platformJobId} 是 2026-09-22 新增的**岗位映射键**（设计文档
 * candidate-position-linking.md 路径 A）：发布成功那一刻扩展若能拿到
 * 平台侧岗位 ID，一并回传即可让「平台岗位 → 需求单」的映射自动成立，
 * 后续采集到的投递才能被归到正确的职位下。</p>
 *
 * <p>⚠️ 拿不到就**留空**，不要猜。服务端对空值的行为是「映射留空、等人工绑定」，
 * 而不是按标题模糊匹配——标题是人工两次输入，必然漂移（实测库里同时存在
 * 「Java高级工程师」与「Java工程师」），猜错会把候选人归到错误的职位下。</p>
 */
@Data
public class RecordReportDTO {

    @NotBlank(message = "回填状态不能为空")
    @Pattern(regexp = "published|failed", message = "回填状态必须是 published/failed")
    private String status;

    @Size(max = 64, message = "账号标识不能超过 64 字")
    private String accountLabel;

    @Size(max = 512, message = "发布链接不能超过 512 字")
    private String publishedUrl;

    /**
     * 平台侧岗位 ID（BOSS jobId）。可选：拿不到就留空。
     *
     * <p>只在「该台账尚未绑定过岗位」时才被写入（自动不覆盖人工，见
     * {@code PublishRecordService.report}）；且若该岗位已被**别的**台账占用，
     * 服务端返回 409 而不是静默抢占——一个平台岗位只能属于一个需求单。</p>
     */
    @Size(max = 64, message = "平台岗位 ID 不能超过 64 字")
    private String platformJobId;

    @Size(max = 512, message = "结果备注不能超过 512 字")
    private String resultNote;
}
