package com.recruit.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.recruit.entity.Channel;
import com.recruit.entity.HrRequest;
import com.recruit.entity.PublishDraft;
import com.recruit.mapper.ChannelMapper;
import com.recruit.mapper.PublishDraftMapper;
import com.recruit.mapper.PublishRecordMapper;
import com.recruit.support.MybatisPlusTestSupport;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.LocalDateTime;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 渲染白名单控制测试。
 *
 * <p>出处：设计文档 §5.3「渲染白名单（硬编码常量）」与 §11 风险表「误把敏感字段带进草稿
 * → 渲染层硬编码白名单 + <b>单测断言 fields_json 键集合</b>」。本测试即该对策的落地。</p>
 *
 * <p><b>为什么断言「精确相等」而不是「⊆ 生产白名单常量」</b>：若断言从生产代码的白名单常量推导，
 * 那么以后有人往白名单里加字段时测试会静默跟随放宽，控制当场失效（自指恒真）。
 * 因此这里把「允许公开的字段集」在测试内独立硬编码为 golden list，做双向断言：</p>
 * <ul>
 *   <li>渲染结果 ⊆ golden list —— 防泄漏（红线 2）；</li>
 *   <li>渲染结果 ⊇ golden list —— 防白名单常量与取值分支（{@code resolveValue}）不同步：
 *       加了常量却忘写取值分支时字段会静默丢失。</li>
 * </ul>
 *
 * <p>测试只走公开入口 {@link PublishDraftService#renderForRequest}，不反射私有成员、不改生产代码可见性。</p>
 */
class PublishDraftRenderTest {

    private static final Long REQUEST_ID = 1001L;

    /** golden list：允许出系统的 JD 公开字段（14 项，见 §5.3 与 T4.2 扩充记录） */
    private static final Set<String> EXPECTED_PUBLIC_FIELDS = Set.of(
            "title", "jobDescription", "jobRequirement", "location",
            "salaryMin", "salaryMax", "salaryText",
            "education", "experienceYears", "employmentType",
            "deptName", "headcountTotal", "requestNo", "publishDate");

    /**
     * 内部字段：在「填满的需求单」上均有真实取值。正因有值，渲染层一旦漏过白名单就会真的泄漏，
     * 断言其缺席才是有意义的控制（对比 NON_EXISTENT_KEYS 的纵深防御断言）。
     */
    private static final List<String> RESOLVABLE_INTERNAL_FIELDS = List.of(
            "id", "status", "closeReason", "autoClose", "rejectReason",
            "openedAt", "closedAt", "createdBy", "createdAt", "updatedAt",
            "headcountFilled");

    /** 需求单上根本不存在的键：纵深防御，防止将来有人图省事整对象序列化 */
    private static final List<String> NON_EXISTENT_KEYS = List.of(
            "password", "phone", "email", "candidatePii", "internalNote", "resumeUrl");

    /** renderForRequest 内部会构造 LambdaUpdateWrapper<PublishDraft>，需先引导 MP 实体缓存 */
    @BeforeAll
    static void bootstrapMybatisPlus() {
        MybatisPlusTestSupport.initTableInfo(PublishDraft.class);
    }

    @Test
    @DisplayName("渠道声明字段 ∩ 白名单：渲染结果与 golden list 精确一致，内部字段零泄漏")
    void rendersExactlyThePublicWhitelist() {
        // 渠道声明「白名单字段 + 内部字段 + 不存在的字段」的全集，模拟平台改版后 field_map 被改宽的最坏情况
        Channel channel = channel(declaringKeys());

        Map<String, Object> rendered = renderDraft(fullRequest(), channel);

        assertThat(rendered.keySet())
                .as("渲染结果必须是白名单字段集的精确集合（不泄漏、也不丢字段）")
                .containsExactlyInAnyOrderElementsOf(EXPECTED_PUBLIC_FIELDS);
        assertThat(rendered.keySet())
                .as("内部字段即便被渠道声明且有值，也不得进入 fields_json（红线 2）")
                .doesNotContainAnyElementsOf(RESOLVABLE_INTERNAL_FIELDS);
        assertThat(rendered.keySet())
                .as("不存在的键不得凭空出现")
                .doesNotContainAnyElementsOf(NON_EXISTENT_KEYS);
    }

    @Test
    @DisplayName("派生字段：salaryText 千元化、publishDate 取 createdAt 日期、requestNo 原样透传")
    void derivesSalaryTextAndPublishDate() {
        Channel channel = channel(List.of("salaryMin", "salaryMax", "salaryText", "publishDate", "requestNo"));

        Map<String, Object> rendered = renderDraft(fullRequest(), channel);

        assertThat(rendered).containsOnlyKeys("salaryMin", "salaryMax", "salaryText", "publishDate", "requestNo");
        assertThat(rendered.get("salaryText")).as("15000-25000 元应渲染为 15-25K").isEqualTo("15-25K");
        assertThat(rendered.get("publishDate")).as("publishDate 取 createdAt 的 UTC 日期").isEqualTo("2026-09-16");
        assertThat(rendered.get("requestNo")).isEqualTo("REQ-20260916-0007");
    }

    @Test
    @DisplayName("白名单字段无值时不出现在 fields_json（不写 null 占位）")
    void omitsWhitelistFieldsWithoutValue() {
        HrRequest sparse = new HrRequest();
        sparse.setId(REQUEST_ID);
        sparse.setRequestNo("REQ-20260916-0008");
        sparse.setTitle("算法工程师");
        // jobDescription / location / salary* / education / experienceYears / employmentType / deptName 全为 null
        Channel channel = channel(List.of("title", "jobDescription", "salaryText", "deptName"));

        Map<String, Object> rendered = renderDraft(sparse, channel);

        assertThat(rendered).containsOnlyKeys("title");
        assertThat(rendered.get("title")).isEqualTo("算法工程师");
    }

    @Test
    @DisplayName("深链实例化：{requestNo} 占位被替换为需求编号")
    void instantiatesDeepLinkPlaceholder() {
        PublishDraft draft = firstDraft(fullRequest(), channel(List.of("title")));

        assertThat(draft.getDeepLink())
                .isEqualTo("https://recruit.example.com/portal/job?no=REQ-20260916-0007");
    }

    @Test
    @DisplayName("渠道 field_map_json 损坏时不抛异常，退化为空 fields_json（防御性容错）")
    void toleratesBrokenFieldMap() {
        Channel broken = channel(List.of("title"));
        broken.setFieldMapJson("{ 这不是合法 JSON");

        Map<String, Object> rendered = renderDraft(fullRequest(), broken);

        assertThat(rendered).isEmpty();
    }

    // ==================== helpers ====================

    private Map<String, Object> renderDraft(HrRequest request, Channel channel) {
        JSONObject fieldsJson = JSON.parseObject(firstDraft(request, channel).getFieldsJson());
        Map<String, Object> rendered = new LinkedHashMap<>();
        fieldsJson.forEach(rendered::put);
        return rendered;
    }

    /** 走公开入口 renderForRequest，捕获唯一插入的草稿 */
    private PublishDraft firstDraft(HrRequest request, Channel channel) {
        PublishDraftMapper draftMapper = mock(PublishDraftMapper.class);
        ChannelMapper channelMapper = mock(ChannelMapper.class);
        PublishRecordMapper recordMapper = mock(PublishRecordMapper.class);
        PublishRecordService recordService = mock(PublishRecordService.class);
        when(channelMapper.selectList(any())).thenReturn(List.of(channel));

        new PublishDraftService(draftMapper, channelMapper, recordMapper, recordService).renderForRequest(request);

        ArgumentCaptor<PublishDraft> captor = ArgumentCaptor.forClass(PublishDraft.class);
        org.mockito.Mockito.verify(draftMapper).insert(captor.capture());
        return captor.getValue();
    }

    /** 填满所有公开字段的需求单：保证每个白名单字段都能取到非 null 值 */
    private HrRequest fullRequest() {
        HrRequest r = new HrRequest();
        r.setId(REQUEST_ID);
        r.setRequestNo("REQ-20260916-0007");
        r.setTitle("Java 后端工程师");
        r.setDeptName("研发中心");
        r.setHeadcountTotal(2);
        r.setHeadcountFilled(1);
        r.setJobDescription("负责 recruit-platform 后端模块设计与开发");
        r.setJobRequirement("熟悉 Java 17 / Spring Boot / MyBatis-Plus");
        r.setSalaryMin(15000);
        r.setSalaryMax(25000);
        r.setLocation("深圳");
        r.setEducation("bachelor");
        r.setExperienceYears(3);
        r.setEmploymentType("full_time");
        r.setStatus("open");
        r.setCloseReason("filled");
        r.setAutoClose(true);
        r.setRejectReason("薪资区间需复核");
        r.setOpenedAt(LocalDateTime.of(2026, 9, 15, 2, 0));
        r.setClosedAt(LocalDateTime.of(2026, 9, 20, 2, 0));
        r.setCreatedBy(9001L);
        r.setCreatedAt(LocalDateTime.of(2026, 9, 16, 1, 30));
        r.setUpdatedAt(LocalDateTime.of(2026, 9, 16, 3, 0));
        return r;
    }

    /** 渠道声明键全集：白名单字段 + 内部字段 + 不存在的键 */
    private List<String> declaringKeys() {
        return Stream.of(EXPECTED_PUBLIC_FIELDS, RESOLVABLE_INTERNAL_FIELDS, NON_EXISTENT_KEYS)
                .flatMap(Collection::stream)
                .toList();
    }

    private Channel channel(List<String> declaredKeys) {
        Channel c = new Channel();
        c.setId(2001L);
        c.setCode("mock_demo");
        c.setName("本地模拟渠道");
        c.setCapability("manual");
        c.setStatus("enabled");
        c.setSortOrder(0);
        c.setDeepLinkTemplate("https://recruit.example.com/portal/job?no={requestNo}");
        c.setFieldMapJson(fieldMap(declaredKeys));
        return c;
    }

    private String fieldMap(List<String> declaredKeys) {
        StringBuilder sb = new StringBuilder("{\"fields\":[");
        for (int i = 0; i < declaredKeys.size(); i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append("{\"key\":\"").append(declaredKeys.get(i)).append("\",\"match\":[\"占位\"],\"type\":\"input\"}");
        }
        return sb.append("]}").toString();
    }
}
