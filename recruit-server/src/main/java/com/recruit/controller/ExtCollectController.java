package com.recruit.controller;

import com.recruit.common.R;
import com.recruit.dto.ExtAttachmentFailDTO;
import com.recruit.dto.ExtAuditDTO;
import com.recruit.dto.ExtCollectSubmitDTO;
import com.recruit.service.CollectService;
import com.recruit.vo.ExtAttachmentContentVO;
import com.recruit.vo.ExtCollectResultVO;
import com.recruit.vo.ExtRulesVO;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * 扩展端简历采集接口（X-Extension-Token 独立鉴权，复用既有拦截器）。
 *
 * <p>与 {@link ExtApiController}（渠道发布）分开：那个类注释写明「权限语义最小：
 * 仅可拉 pending 草稿与回填台账」，采集是另一套权限语义，混进去会让最小权限失效。</p>
 *
 * <p>extUserId / extTokenId 由 ExtensionAuthInterceptor 挂载。</p>
 */
@RequiredArgsConstructor
@RestController
@RequestMapping("/api/ext/collect")
public class ExtCollectController {

    private final CollectService collectService;

    /**
     * 规则下发（框架 §0 总原则第 3 条「逻辑后置」）：
     * 命中键表、附件识别规则、噪声黑名单全部由后端给，平台改版时不用发版扩展。
     */
    @GetMapping("/rules")
    public R<ExtRulesVO> rules() {
        return R.ok(collectService.rules());
    }

    /** 提交采集：HR 一次主动采集 = 一次请求（服务端强制逐条，拒绝批量） */
    @PostMapping("/resumes")
    public R<ExtCollectResultVO> submit(@Valid @RequestBody ExtCollectSubmitDTO dto,
                                       HttpServletRequest request) {
        return R.ok(collectService.submit(dto, extUserId(request), extTokenId(request)));
    }

    /** 审计上报：仅用于「已确认未提交」「提交失败」场景，成功提交的审计由上面那支自动写 */
    @PostMapping("/audit")
    public R<String> audit(@Valid @RequestBody ExtAuditDTO dto, HttpServletRequest request) {
        return R.ok(collectService.reportAudit(dto, extUserId(request), extTokenId(request)));
    }

    /** 附件字节上传：扩展端用 SW 重放下载成功后回传（零膨胀，不经 base64） */
    @PostMapping("/attachments/{id}/content")
    public R<ExtAttachmentContentVO> uploadContent(@PathVariable Long id,
                                                   @RequestParam("file") MultipartFile file,
                                                   @RequestParam(value = "sha256", required = false) String sha256,
                                                   HttpServletRequest request) {
        return R.ok(collectService.saveAttachmentContent(id, file, sha256,
                extUserId(request), extTokenId(request)));
    }

    /** 附件下载失败回报（保留原因，V4 命题的证据） */
    @PostMapping("/attachments/{id}/fail")
    public R<Void> reportAttachmentFail(@PathVariable Long id,
                                        @Valid @RequestBody ExtAttachmentFailDTO dto,
                                        HttpServletRequest request) {
        collectService.markAttachmentFailed(id, dto.getReason(), extUserId(request), extTokenId(request));
        return R.ok();
    }

    private Long extUserId(HttpServletRequest request) {
        Object v = request.getAttribute("extUserId");
        return v instanceof Long l ? l : null;
    }

    private Long extTokenId(HttpServletRequest request) {
        Object v = request.getAttribute("extTokenId");
        return v instanceof Long l ? l : null;
    }
}
