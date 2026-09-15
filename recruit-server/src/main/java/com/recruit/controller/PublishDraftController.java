package com.recruit.controller;

import com.recruit.common.R;
import com.recruit.service.PublishDraftService;
import com.recruit.vo.PublishDraftVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 发布草稿查询（管理端登录态；扩展端拉草稿接口在 T3.3 以扩展 token 独立鉴权）
 */
@RequiredArgsConstructor
@RestController
public class PublishDraftController {

    private final PublishDraftService publishDraftService;

    /** 某需求的草稿列表（含渠道元数据） */
    @GetMapping("/api/hr-requests/{id}/drafts")
    public R<List<PublishDraftVO>> listByRequest(@PathVariable Long id) {
        return R.ok(publishDraftService.listByRequest(id));
    }
}
