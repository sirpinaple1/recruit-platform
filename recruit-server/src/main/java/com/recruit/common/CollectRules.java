package com.recruit.common;

import java.util.List;

/**
 * 采集规则常量（代码契约，不是可配置数据）。
 *
 * <p>命名与定位同 {@link DomainEventTypes}：规则值直接决定「命中判定」的语义，
 * 改规则必须改代码，否则采集结果会静默漂移。若将来要热更新，应整体迁到
 * {@code sys_dict} 并保证版本号可比对（见 ExtRulesVO.version）。</p>
 *
 * <p><b>所有值均来自 Phase 0 真机实测</b>（zhipin.com，2026-09-21，1180 条捕获）：
 * <ul>
 *   <li>初版键表猜的 {@code fileId/fileName/enclosureList} 在真实响应里<b>根本不存在</b>
 *       （全量 1128 个键名零命中），附件是平台生成的 PDF，只能按 URL + content-type 识别；</li>
 *   <li>简历字段至少三套命名：{@code chat/geek/info} 用 {@code workExpList/eduExpList}，
 *       聊天简历卡片用 {@code experiences/content1..3}，推荐列表用 {@code geekCard}；</li>
 *   <li>{@code jobStatus} 在职位列表里是「职位状态」而非求职状态，必须降级为噪声键。</li>
 * </ul></p>
 */
public final class CollectRules {

    /** 规则版本：改动本类常量时必须同步递增，扩展端据此判断是否需要刷新规则 */
    public static final String VERSION = "boss-20260921-V2";

    /** 首发平台标识（框架已定 D3） */
    public static final String PLATFORM_BOSS = "boss";

    /**
     * 命中键：出现任一即判为简历数据。
     * 含 Phase 0 实测补入的聊天简历卡片字段。
     */
    public static final List<String> RESUME_KEYS = List.of(
            // 聊天/列表链路（/wapi/zpjob/chat/geek/info）
            "geekName", "expectSalary", "geekCard", "advantage",
            "workExp", "eduExp", "workExpList", "eduExpList",
            // 聊天简历卡片消息（/wapi/zpchat/boss/historyMsg → body.resume）
            "experiences", "content1", "content2", "content3",
            "workYear", "positionCategory", "applyStatus", "education",
            "salary", "jobSalary", "bottomText", "ageDesc"
    );

    /**
     * 噪声键：命中只记录到 noisyKeys，不参与命中判定。
     * 依据 Phase 0：{@code jobStatus} 在 /wapi/zpjob/job/data/list 里表示「职位状态」，曾造成误报。
     */
    public static final List<String> NOISY_KEYS = List.of(
            "jobStatus", "status", "name", "position"
    );

    /** 附件 URL 识别（Phase 0 实测：BOSS 简历 PDF 走此端点） */
    public static final String ATTACH_URL_PATTERN = "/wflow/[^/]+/download/";

    /** 附件 content-type 识别 */
    public static final String ATTACH_CONTENT_TYPE_PATTERN =
            "application/(pdf|octet-stream|msword|zip)|officedocument|image/(jpeg|png)";

    /**
     * 噪声接口路径前缀：埋点/APM 类，Phase 0 两轮实测占全部请求约 46%
     * （/wapi/zpApm/actionLog/fe/ie 221 次 + /wapi/zpCommon/actionLog 116 次 + …）。
     * 扩展端命中这些前缀直接丢弃，避免污染缓冲区。
     */
    public static final List<String> NOISE_PATH_PREFIXES = List.of(
            "/wapi/zpCommon/actionLog/",
            "/wapi/zpApm/actionLog/",
            "/wapi/zpApm/httpMetrics/"
    );

    /** 采集场景：对应候选人页面的位置 */
    public static final List<String> SCENES = List.of("list", "detail", "chat", "attach");

    /**
     * 来源渠道：区分「候选人主动来」与「我方主动发」。
     * 这个区分不只是标签 —— 渠道 recommend 的列表接口一次翻页就带回一整页候选人，
     * 采集必须逐条确认，禁止整页批量提交（框架 §6 红线第 1 条）。
     */
    public static final List<String> SOURCE_CHANNELS = List.of("chat", "recommend");

    /** 面板提示语 */
    public static final String NOTE = "逐条采集：每次点击只采集当前正在查看的候选人；"
            + "不支持整页批量提交。附件按 URL + content-type 识别，不依赖 JSON 字段名。";

    private CollectRules() {
    }
}
