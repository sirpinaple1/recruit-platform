package com.recruit.vo;

import lombok.Builder;
import lombok.Data;

import java.util.List;

/**
 * 扩展端动态下发的采集规则（框架 §2 接口契约 GET rules；§0 总原则「逻辑后置」）。
 *
 * <p>这是整个方案「插件保持薄」的关键：筛选键表、附件识别规则、噪声黑名单全部由后端下发，
 * 平台改字段或改版时只改后端配置，扩展不用发版。</p>
 *
 * <p>当前值来自 Phase 0 真机实测（zhipin.com 2026-09-21），不是拍脑袋的猜测值。</p>
 */
@Data
@Builder
public class ExtRulesVO {

    private String platform;

    /** 规则版本号，扩展端可比对判断是否需要刷新 */
    private String version;

    /** 命中键：出现即判为简历数据（实测修正版，含聊天简历卡片字段） */
    private List<String> resumeKeys;

    /** 噪声键：命中只记录不判定（如 jobStatus 在职位列表里是「职位状态」） */
    private List<String> noisyKeys;

    /** 附件 URL 识别正则（Phase 0 实测：附件不在 JSON 里，只能按 URL + content-type 识别） */
    private String attachUrlPattern;

    /** 附件 content-type 识别正则 */
    private String attachContentTypePattern;

    /** 噪声接口路径黑名单前缀（埋点/APM，实测占比约 46%） */
    private List<String> noisePathPrefixes;

    /** 采集场景与来源渠道的合法取值，扩展端 UI 用 */
    private List<String> scenes;

    private List<String> sourceChannels;

    /** 后续说明（如红线条目），展示在扩展面板 */
    private String note;
}
