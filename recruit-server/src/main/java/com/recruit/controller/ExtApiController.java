package com.recruit.controller;

import com.recruit.common.MyException;
import com.recruit.common.R;
import com.recruit.dto.RecordReportDTO;
import com.recruit.service.PublishRecordService;
import com.recruit.vo.ExtDraftVO;
import com.recruit.vo.PublishRecordVO;
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

import java.util.List;

/**
 * 扩展端接口（X-Extension-Token 独立鉴权，见设计文档 §6.2）：
 * 权限语义最小：仅可拉 pending 草稿与回填台账。
 * extUserId 由 ExtensionAuthInterceptor 挂载（token 关联的 sys_user）。
 */
@RequiredArgsConstructor
@RestController
@RequestMapping("/api/ext")
public class ExtApiController {

    private final PublishRecordService publishRecordService;

    /** 待发布草稿列表（含 fields_json、渠道元数据与 recordId；一期仅 pending，不按用户隔离） */
    @GetMapping("/drafts")
    public R<List<ExtDraftVO>> listDrafts(@RequestParam(defaultValue = "pending") String status) {
        if (!"pending".equals(status)) {
            throw new MyException(400, "一期仅支持 status=pending");
        }
        return R.ok(publishRecordService.listPendingForExt());
    }

    /** 回填台账：published/failed 终结，operated_by 取扩展 token 关联用户 */
    @PostMapping("/records/{id}/report")
    public R<PublishRecordVO> report(@PathVariable Long id,
                                     @Valid @RequestBody RecordReportDTO dto,
                                     HttpServletRequest request) {
        Long extUserId = (Long) request.getAttribute("extUserId");
        return R.ok(publishRecordService.report(id, dto, extUserId));
    }
}
