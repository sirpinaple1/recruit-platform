package com.recruit.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONException;
import com.alibaba.fastjson2.JSONObject;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.recruit.common.MyException;
import com.recruit.dto.ChannelSaveDTO;
import com.recruit.entity.Channel;
import com.recruit.mapper.ChannelMapper;
import com.recruit.vo.ChannelVO;
import lombok.RequiredArgsConstructor;
import lombok.extern.log4j.Log4j2;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.List;
import java.util.Set;

/**
 * 渠道注册表 CRUD（新增渠道 = 插数据不改代码，见设计文档 §5.2）
 */
@Log4j2
@RequiredArgsConstructor
@Service
public class ChannelService {

    /** 能力等级合法值（本期只实装 manual，其余为预留） */
    private static final Set<String> CAPABILITIES = Set.of("manual", "api", "connector", "rpa");

    /** 状态合法值 */
    private static final Set<String> STATUSES = Set.of("enabled", "disabled");

    private final ChannelMapper channelMapper;

    /** 新增渠道 */
    public ChannelVO create(ChannelSaveDTO dto) {
        Channel entity = new Channel();
        copyEditableFields(entity, dto);
        entity.setCode(dto.getCode().trim());
        entity.setCapability(defaultIfBlank(dto.getCapability(), "manual"));
        entity.setStatus(defaultIfBlank(dto.getStatus(), "enabled"));
        entity.setSortOrder(dto.getSortOrder() == null ? 0 : dto.getSortOrder());
        try {
            channelMapper.insert(entity);
        } catch (DuplicateKeyException e) {
            throw new MyException(409, "渠道代码已存在：" + entity.getCode());
        }
        return ChannelVO.from(channelMapper.selectById(entity.getId()));
    }

    /** 全量列表（渠道量小不分页，按 sort_order -> id 升序） */
    public List<ChannelVO> list() {
        List<Channel> records = channelMapper.selectList(new LambdaQueryWrapper<Channel>()
                .orderByAsc(Channel::getSortOrder)
                .orderByAsc(Channel::getId));
        return records.stream().map(ChannelVO::from).toList();
    }

    /** 编辑渠道（code 为渠道身份标识，创建后不可修改） */
    public ChannelVO update(Long id, ChannelSaveDTO dto) {
        Channel entity = requireById(id);
        if (dto.getCode() != null && !entity.getCode().equals(dto.getCode().trim())) {
            throw new MyException(400, "渠道代码创建后不可修改（当前 " + entity.getCode() + "）");
        }
        copyEditableFields(entity, dto);
        entity.setCapability(defaultIfBlank(dto.getCapability(), "manual"));
        entity.setStatus(defaultIfBlank(dto.getStatus(), "enabled"));
        entity.setSortOrder(dto.getSortOrder() == null ? 0 : dto.getSortOrder());
        channelMapper.updateById(entity);
        return ChannelVO.from(channelMapper.selectById(id));
    }

    // ==================== 内部方法 ====================

    private Channel requireById(Long id) {
        Channel entity = channelMapper.selectById(id);
        if (entity == null) {
            throw new MyException(404, "渠道不存在");
        }
        return entity;
    }

    /** 可编辑字段拷贝 + 枚举 / JSON 校验（field_map_json 规范化后落库） */
    private void copyEditableFields(Channel entity, ChannelSaveDTO dto) {
        if (dto.getCapability() != null && !CAPABILITIES.contains(dto.getCapability())) {
            throw new MyException(400, "能力等级必须是 manual/api/connector/rpa");
        }
        if (dto.getStatus() != null && !STATUSES.contains(dto.getStatus())) {
            throw new MyException(400, "状态必须是 enabled/disabled");
        }
        entity.setName(dto.getName().trim());
        entity.setPublishUrlPattern(StringUtils.hasText(dto.getPublishUrlPattern()) ? dto.getPublishUrlPattern().trim() : null);
        entity.setFieldMapJson(normalizeFieldMap(dto.getFieldMapJson()));
        entity.setDeepLinkTemplate(StringUtils.hasText(dto.getDeepLinkTemplate()) ? dto.getDeepLinkTemplate().trim() : null);
        entity.setRemark(StringUtils.hasText(dto.getRemark()) ? dto.getRemark().trim() : null);
    }

    /** 校验字段映射为合法 JSON 对象并规范化（解析失败抛 4xx） */
    private String normalizeFieldMap(String raw) {
        try {
            JSONObject parsed = JSON.parseObject(raw);
            return parsed.toJSONString();
        } catch (JSONException e) {
            throw new MyException(400, "字段映射配置不是合法的 JSON 对象");
        }
    }

    private String defaultIfBlank(String v, String def) {
        return StringUtils.hasText(v) ? v : def;
    }
}
