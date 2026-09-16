package com.recruit.controller;

import com.recruit.common.R;
import com.recruit.common.RequireRole;
import com.recruit.common.Roles;
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
 *
 * <p>写操作收敛到 ADMIN：field_map_json / deep_link_template 是所有后续发布的控制参数，
 * 改动它等于改动发布内容流向（见 ADR-001）。查询保持登录态即可——
 * 台账页与需求详情页需要展示渠道名称。</p>
 */
@RequiredArgsConstructor
@RestController
@RequestMapping("/api/channels")
public class ChannelController {

    private final ChannelService channelService;

    /** 新增渠道（ADMIN） */
    @RequireRole(Roles.ADMIN)
    @PostMapping
    public R<ChannelVO> create(@Valid @RequestBody ChannelSaveDTO dto) {
        return R.ok(channelService.create(dto));
    }

    /** 全量列表（渠道量小不分页） */
    @GetMapping
    public R<List<ChannelVO>> list() {
        return R.ok(channelService.list());
    }

    /** 编辑渠道（ADMIN；code 不可改，停用走 status=disabled，不提供物理删除） */
    @RequireRole(Roles.ADMIN)
    @PutMapping("/{id}")
    public R<ChannelVO> update(@PathVariable Long id, @Valid @RequestBody ChannelSaveDTO dto) {
        return R.ok(channelService.update(id, dto));
    }
}
