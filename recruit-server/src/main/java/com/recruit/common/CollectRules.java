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
    public static final String VERSION = "boss-20260922-V3";

    /** 首发平台标识（框架已定 D3） */
    public static final String PLATFORM_BOSS = "boss";

    /**
     * 具备采集能力（会把候选人投递上报回来）的平台集合。
     *
     * <p><b>为什么这个常量是数据一致性的一环</b>：候选人投递的归属由
     * {@code (platform, platform_job_id)} 解析，而 {@code platform} 取自采集上报
     * （{@link #PLATFORM_BOSS}，且 {@code CollectService.submit} 只接受它）。
     * 台账侧记录的映射键是 {@code (channel_id → channel.code, platform_job_id)}。
     * 两者只有在 <b>台账所属渠道的 code 等于采集平台</b>时才可能匹配 ——
     * 否则映射写得再对，也永远解析不到任何候选人。</p>
     *
     * <p>所以发布台账侧必须在写入映射前用本集合校验渠道：
     * 让「绑定了一个永远不会生效的岗位」当场被拒绝，而不是留下一个
     * 台账上显示「已关联」、候选人却永远归不了类的<b>静默失效</b>。
     * 这类"看着成功、实际没接线"的状态最难排查，必须由代码拦住。</p>
     */
    public static final List<String> CAPTURABLE_PLATFORMS = List.of(PLATFORM_BOSS);

    /**
     * 岗位 ID 键：从候选人节点上取「这次投递的是平台上的哪个岗位」。
     *
     * <p><b>为什么放在这里而不是 channel.field_map_json</b>：它与 {@link #RESUME_KEYS}、
     * {@link #ATTACH_URL_PATTERN} 是同一类东西——「如何从平台响应里认出某样东西」的
     * 识别规则，本类的定位就是这类规则的唯一代码真源。放到渠道数据里会形成
     * 两份必须人工同步的枚举（正是 {@code sys_dict} 那条设计债务的成因），不做。</p>
     *
     * <p><b>取值依据（Phase 1 真机实测）</b>：聊天简历卡片
     * {@code body.resume.jobId} 为<b>数字</b>（实测 6/6 命中，值 575500411），
     * 与 {@code bottomText}「9月21日 沟通的职位-Java」同一节点。</p>
     *
     * <p>⚠️ <b>2026-09-22 真机取证推翻了一个隐含前提</b>：岗位 ID 与「人」的 ID 一样，
     * 存在<b>两套 ID 空间</b> —— 数字 {@code 575500411} 只出现在聊天/候选人侧，
     * 加密 {@code 352f92eda67db1080nN_3t29FFNR} 只出现在职位管理侧（含发布响应
     * {@code /wapi/zpjob/job/save}）。更麻烦的是 <b>{@code jobId} 这个键名本身不可信</b>：
     * 它在 {@code /wapi/zpjob/job/data/list} 里装数字，在 {@code job/save} 里装加密。</p>
     *
     * <p>所以判定岗位 ID 的形态必须<b>按值的形状</b>（见 {@link #isEncryptedJobId}），
     * <b>绝不能按键名</b>。规范形态见 {@link #JOB_ID_CANONICAL_ENCRYPTED}。</p>
     */
    public static final List<String> JOB_ID_KEYS = List.of(
            "jobId", "encryptJobId", "jobIdEncrypt"
    );

    /**
     * 岗位 ID 的<b>规范形态 = 加密形态</b>。
     *
     * <p>这不是偏好，是唯一自洽的方向：<br>
     * 若选数字——新发布的岗位在「桥」里<b>还没有数字形态</b>（还没有任何候选人跟它聊过），
     * 发布当时换不出来；<br>
     * 若选加密——发布响应直接就给加密值，采集时该岗位必已进入
     * {@code chatted/jobList}（两种形态同框），可当场换。</p>
     *
     * <p>因此：{@code publish_record.platform_job_id} 与
     * {@code candidate_application.platform_job_id} 都必须是加密形态。</p>
     */
    public static final boolean JOB_ID_CANONICAL_ENCRYPTED = true;

    /**
     * 判断一个岗位 ID 值是不是<b>加密形态</b>。
     *
     * <p>口径与扩展端 {@code background.js #looksEncryptedId} 严格一致：
     * 16~64 位、只含 {@code [0-9A-Za-z_~-]}、且数字字母都至少有一个。</p>
     *
     * <p>为什么必须按值判定：真机实测同一个键 {@code jobId} 在不同接口里
     * 分别装数字与加密，按键名判定必然出错。</p>
     */
    public static boolean isEncryptedJobId(String v) {
        if (v == null) {
            return false;
        }
        String s = v.trim();
        if (!s.matches("[0-9A-Za-z_~-]{16,64}")) {
            return false;
        }
        return s.chars().anyMatch(Character::isDigit)
                && s.chars().anyMatch(Character::isLetter);
    }

    /**
     * 判断一个岗位 ID 值是不是<b>数字形态</b>（下限 6 位，避免把状态码 0/1 当 ID）。
     *
     * <p>口径与扩展端 {@code background.js #looksNumericId} 一致。</p>
     */
    public static boolean isNumericJobId(String v) {
        if (v == null) {
            return false;
        }
        String s = v.trim();
        if (!s.matches("\\d{6,15}")) {
            return false;
        }
        return Long.parseLong(s) > 0;
    }

    /**
     * 岗位文本提示键：平台原文的岗位线索，**仅供人工辨认**，不参与任何自动判定。
     *
     * <p>实测值是「9月21日 沟通的职位-Java」这种**拼接文本**（沟通日期 + 职位名），
     * 不是干净的岗位名；且日期会变。所以只落 {@code platform_job_hint} 供人看，
     * 绝不拿它去匹配 {@code hr_request.title}。</p>
     */
    public static final List<String> JOB_HINT_KEYS = List.of(
            "bottomText"
    );

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
