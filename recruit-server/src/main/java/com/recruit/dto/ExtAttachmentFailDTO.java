package com.recruit.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

/**
 * 附件下载失败回报（Phase 0 V4 命题的证据载体）。
 *
 * <p>失败原因必须原样记录 —— Phase 0 的 SW 重放实测 15/15 成功，
 * 但附件本体（二进制下载）尚未验证；一旦失败，是「票据过期」「cookie 未带上」
 * 还是「无 Referer 被风控」三类原因的区分，全靠这条 reason。</p>
 */
@Data
public class ExtAttachmentFailDTO {

    @NotBlank(message = "失败原因不能为空")
    @Size(max = 512, message = "失败原因不能超过 512 字")
    private String reason;
}
