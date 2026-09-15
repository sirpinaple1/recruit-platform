package com.recruit.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.recruit.entity.Channel;
import com.recruit.entity.HrRequest;
import com.recruit.entity.PublishDraft;
import com.recruit.mapper.ChannelMapper;
import com.recruit.mapper.PublishDraftMapper;
import com.recruit.vo.PublishDraftVO;
import lombok.RequiredArgsConstructor;
import lombok.extern.log4j.Log4j2;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 发布草稿渲染与生命周期（见设计文档 §5.3）
 *
 * 渲染规则：fields_json 只含「渠道声明字段 ∩ 白名单」且有值的部分；
 * 白名单为硬编码常量，其余字段一律不进 fields_json（红线 2：不外发非公开信息）。
 */
@Log4j2
@RequiredArgsConstructor
@Service
public class PublishDraftService {

    /** 渲染白名单（硬编码常量，§5.3）：JD 公开字段，超出范围一律不渲染 */
    private static final Set<String> RENDER_WHITELIST = Set.of(
            "title", "jobDescription", "jobRequirement", "location",
            "salaryMin", "salaryMax", "salaryText",
            "education", "experienceYears", "employmentType");

    private final PublishDraftMapper publishDraftMapper;
    private final ChannelMapper channelMapper;
    private final PublishRecordService publishRecordService;

    /**
     * 需求审批通过：为每个 enabled 且 capability=manual 的渠道渲染一条 pending 草稿 + pending 台账。
     * 先把该需求存量 pending 置 cancelled、未回填台账置 failed（重渲染规则：
     * 同一 (request, channel) 只一条 pending，reopen 后二次 approve 幂等）。
     */
    @Transactional(rollbackFor = Exception.class)
    public void renderForRequest(HrRequest request) {
        cancelPendingByRequest(request.getId());
        publishRecordService.failPendingByRequest(request.getId(), "需求重新审批，草稿重渲染，未回填台账作废");
        List<Channel> channels = channelMapper.selectList(new LambdaQueryWrapper<Channel>()
                .eq(Channel::getStatus, "enabled")
                .eq(Channel::getCapability, "manual")
                .orderByAsc(Channel::getSortOrder)
                .orderByAsc(Channel::getId));
        for (Channel channel : channels) {
            PublishDraft draft = new PublishDraft();
            draft.setRequestId(request.getId());
            draft.setChannelId(channel.getId());
            draft.setFieldsJson(renderFields(request, channel).toJSONString());
            draft.setDeepLink(instantiateDeepLink(channel.getDeepLinkTemplate(), request));
            draft.setStatus("pending");
            publishDraftMapper.insert(draft);
            // 一对一台账：与草稿同事务创建（§5.4）
            publishRecordService.createPendingFor(draft);
        }
        log.info("需求 {} 审批通过，渲染渠道草稿 {} 条", request.getRequestNo(), channels.size());
    }

    /** 需求关闭：未消费草稿全部置 cancelled（consumed 保留，台账审计在 T3.3） */
    public void cancelPendingByRequest(Long requestId) {
        publishDraftMapper.update(null, new LambdaUpdateWrapper<PublishDraft>()
                .eq(PublishDraft::getRequestId, requestId)
                .eq(PublishDraft::getStatus, "pending")
                .set(PublishDraft::getStatus, "cancelled"));
    }

    /** 某需求的草稿列表（新在前，含渠道元数据） */
    public List<PublishDraftVO> listByRequest(Long requestId) {
        List<PublishDraft> drafts = publishDraftMapper.selectList(new LambdaQueryWrapper<PublishDraft>()
                .eq(PublishDraft::getRequestId, requestId)
                .orderByDesc(PublishDraft::getId));
        if (drafts.isEmpty()) {
            return List.of();
        }
        Map<Long, Channel> channelById = channelMapper.selectList(null).stream()
                .collect(Collectors.toMap(Channel::getId, Function.identity()));
        return drafts.stream()
                .map(d -> PublishDraftVO.from(d, channelById.get(d.getChannelId())))
                .toList();
    }

    // ==================== 渲染 ====================

    /** 渠道声明字段 ∩ 白名单，有值才进 fields_json */
    private JSONObject renderFields(HrRequest request, Channel channel) {
        JSONObject out = new JSONObject();
        JSONObject fieldMap = parseFieldMap(channel);
        JSONArray fields = fieldMap == null ? null : fieldMap.getJSONArray("fields");
        if (fields == null) {
            return out;
        }
        for (int i = 0; i < fields.size(); i++) {
            String key = fields.getJSONObject(i).getString("key");
            if (key == null || !RENDER_WHITELIST.contains(key)) {
                continue;
            }
            Object value = resolveValue(key, request);
            if (value != null) {
                out.put(key, value);
            }
        }
        return out;
    }

    /** 白名单 key -> 需求字段取值（salaryText 为派生字段） */
    private Object resolveValue(String key, HrRequest r) {
        return switch (key) {
            case "title" -> r.getTitle();
            case "jobDescription" -> r.getJobDescription();
            case "jobRequirement" -> r.getJobRequirement();
            case "location" -> r.getLocation();
            case "salaryMin" -> r.getSalaryMin();
            case "salaryMax" -> r.getSalaryMax();
            case "salaryText" -> salaryText(r);
            case "education" -> r.getEducation();
            case "experienceYears" -> r.getExperienceYears();
            case "employmentType" -> r.getEmploymentType();
            default -> null;
        };
    }

    /** 薪资文本（元 -> 千元展示）：双值 15-25K，仅下限 15K起，仅上限 25K以内 */
    private String salaryText(HrRequest r) {
        Integer min = r.getSalaryMin();
        Integer max = r.getSalaryMax();
        if (min == null && max == null) {
            return null;
        }
        if (min != null && max != null) {
            return roundK(min) + "-" + roundK(max) + "K";
        }
        if (min != null) {
            return roundK(min) + "K起";
        }
        return roundK(max) + "K以内";
    }

    private String roundK(int yuan) {
        return String.valueOf(Math.round(yuan / 1000.0));
    }

    /** 深链实例化：{requestNo} 占位替换为需求编号 */
    private String instantiateDeepLink(String template, HrRequest request) {
        if (!StringUtils.hasText(template)) {
            return null;
        }
        return template.replace("{requestNo}", request.getRequestNo());
    }

    /** 渠道字段映射解析（建渠道时已规范化为合法 JSON，此处防御性容错） */
    private JSONObject parseFieldMap(Channel channel) {
        try {
            return JSON.parseObject(channel.getFieldMapJson());
        } catch (Exception e) {
            log.warn("渠道 {} 字段映射解析失败，跳过渲染", channel.getCode());
            return null;
        }
    }
}
