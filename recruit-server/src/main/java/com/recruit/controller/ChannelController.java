package com.recruit.controller;

import com.recruit.common.R;
import com.recruit.dto.ChannelSaveDTO;
import com.recruit.service.ChannelService;
import com.recruit.vo.ChannelVO;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 渠道注册表 CRUD（管理端，登录态）
 */
@RequiredArgsConstructor
@RestController
@RequestMapping("/api/channels")
public class ChannelController {

    private final ChannelService channelService;

    /** 新增渠道 */
    @PostMapping
    public R<ChannelVO> create(@Valid @RequestBody ChannelSaveDTO dto) {
        return R.ok(channelService.create(dto));
    }

    /** 全量列表（渠道量小不分页） */
    @GetMapping
    public R<List<ChannelVO>> list() {
        return R.ok(channelService.list());
    }

    /** 编辑渠道（code 不可改，停用走 status=disabled，不提供物理删除） */
    @PutMapping("/{id}")
    public R<ChannelVO> update(@PathVariable Long id, @Valid @RequestBody ChannelSaveDTO dto) {
        return R.ok(channelService.update(id, dto));
    }
}
