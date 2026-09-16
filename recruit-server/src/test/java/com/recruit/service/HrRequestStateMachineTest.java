package com.recruit.service;

import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.recruit.common.DomainEventTypes;
import com.recruit.common.MyException;
import com.recruit.entity.HrRequest;
import com.recruit.mapper.HrRequestMapper;
import com.recruit.support.MybatisPlusTestSupport;
import com.recruit.vo.HrRequestVO;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.mockito.ArgumentCaptor;
import org.mockito.ArgumentMatchers;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * hr_request 状态机测试。
 *
 * <p>出处：设计文档 §5.1「状态机（代码内转移表，非法转移抛 MyException 4xx）」。</p>
 *
 * <p><b>转移表在测试内独立硬编码为 golden table</b>，不引用生产常量 {@code TRANSFERS}：
 * 否则改了生产转移表测试会静默跟随，控制失效。矩阵为 5 个 action × 4 个状态 = 20 组合，
 * 其中恰好 5 组合合法——任何一侧改动都会让本测试失败并强制人工确认。</p>
 */
class HrRequestStateMachineTest {

    private static final Long REQUEST_ID = 1001L;

    /** 操作人：状态转移事件应原样记录该值 */
    private static final Long OPERATOR_ID = 9001L;

    /** 合法状态集合（§5.1 status 列取值） */
    private static final List<String> STATUSES = List.of("draft", "pending_approval", "open", "closed");

    /** golden table：合法转移 action@from -> to（5 条，§5.1 状态机图） */
    private static final java.util.Map<String, String> LEGAL_TRANSFERS = java.util.Map.of(
            "submit@draft", "pending_approval",
            "approve@pending_approval", "open",
            "reject@pending_approval", "draft",
            "close@open", "closed",
            "reopen@closed", "draft");

    /** reopen 内部会构造 LambdaUpdateWrapper<HrRequest>，需先引导 MP 实体缓存 */
    @BeforeAll
    static void bootstrapMybatisPlus() {
        MybatisPlusTestSupport.initTableInfo(HrRequest.class);
    }

    // ==================== 1. 转移矩阵（20 组合，非法必须 4xx） ====================

    static Stream<Arguments> transitionMatrix() {
        return STATUSES.stream()
                .flatMap(status -> Stream.of("submit", "approve", "reject", "close", "reopen")
                        .map(action -> Arguments.of(action, status, LEGAL_TRANSFERS.get(action + "@" + status))));
    }

    @ParameterizedTest(name = "{0} @ {1} → {2}")
    @MethodSource("transitionMatrix")
    @DisplayName("转移矩阵：仅 5 组合合法，其余一律 4xx")
    void stateMachineMatrix(String action, String fromStatus, String expectedTarget) {
        HrRequestService service = newService(fromStatus);

        if (expectedTarget == null) {
            assertThatThrownBy(() -> invoke(service, action, REQUEST_ID))
                    .as("%s 在 %s 状态必须被拒绝", action, fromStatus)
                    .isInstanceOfSatisfying(MyException.class,
                            ex -> assertThat(ex.getCode()).as("非法转移用 4xx").isEqualTo(400));
        } else {
            assertThatCode(() -> invoke(service, action, REQUEST_ID))
                    .as("%s 在 %s 状态必须被接受", action, fromStatus)
                    .doesNotThrowAnyException();
        }
    }

    // ==================== 2. 合法转移落库目标状态 ====================

    @Test
    @DisplayName("submit：draft -> pending_approval，且写的是条件更新（WHERE 钉住 draft）")
    void submitPersistsTargetStatus() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        when(mapper.selectById(REQUEST_ID)).thenReturn(submittableEntity("draft"));
        stubCasMatched(mapper);
        HrRequestService service = new HrRequestService(mapper, mock(PublishDraftService.class), mock(PublishRecordService.class), mock(DomainEventService.class));

        service.submit(REQUEST_ID, OPERATOR_ID);

        UpdateCall call = captureCas(mapper);
        assertThat(call.sqlSet()).contains("status");
        assertThat(call.params()).contains("pending_approval");
        assertThat(call.sqlSegment()).as("WHERE 必须钉住源状态").contains("status");
        assertThat(call.params()).contains("draft");
    }

    @Test
    @DisplayName("approve：pending_approval -> open，同时写 opened_at 并渲染渠道草稿")
    void approvePersistsTargetStatusAndRendersDrafts() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        HrRequest entity = submittableEntity("pending_approval");
        when(mapper.selectById(REQUEST_ID)).thenReturn(entity);
        stubCasMatched(mapper);
        PublishDraftService draftService = mock(PublishDraftService.class);
        HrRequestService service = new HrRequestService(mapper, draftService, mock(PublishRecordService.class), mock(DomainEventService.class));

        HrRequestVO vo = service.approve(REQUEST_ID, OPERATOR_ID);

        assertThat(vo.getStatus()).isEqualTo("open");
        assertThat(entity.getOpenedAt()).as("opened_at 是指标口径，必须写入").isNotNull();
        UpdateCall call = captureCas(mapper);
        assertThat(call.sqlSet()).contains("status").contains("opened_at");
        assertThat(call.params()).contains("open");
        verify(draftService).renderForRequest(entity);
    }

    @Test
    @DisplayName("reject：pending_approval -> draft，并记录驳回原因")
    void rejectPersistsDraftAndReason() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        when(mapper.selectById(REQUEST_ID)).thenReturn(submittableEntity("pending_approval"));
        stubCasMatched(mapper);
        HrRequestService service = new HrRequestService(mapper, mock(PublishDraftService.class), mock(PublishRecordService.class), mock(DomainEventService.class));

        service.reject(REQUEST_ID, "薪资区间与预算不符", OPERATOR_ID);

        UpdateCall call = captureCas(mapper);
        assertThat(call.sqlSet()).contains("status").contains("reject_reason");
        assertThat(call.params()).contains("draft").contains("薪资区间与预算不符");
        assertThat(call.sqlSegment()).contains("status");
        assertThat(call.params()).contains("pending_approval");
    }

    @Test
    @DisplayName("close：open -> closed，写 closed_at/close_reason，未消费草稿与台账联动作废")
    void closePersistsClosedAndCascades() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        when(mapper.selectById(REQUEST_ID)).thenReturn(submittableEntity("open"));
        stubCasMatched(mapper);
        PublishDraftService draftService = mock(PublishDraftService.class);
        PublishRecordService recordService = mock(PublishRecordService.class);
        HrRequestService service = new HrRequestService(mapper, draftService, recordService, mock(DomainEventService.class));

        service.close(REQUEST_ID, "cancelled", OPERATOR_ID);

        UpdateCall call = captureCas(mapper);
        assertThat(call.sqlSet()).contains("status").contains("close_reason").contains("closed_at");
        assertThat(call.params()).contains("closed").contains("cancelled");
        assertThat(call.sqlSegment()).as("WHERE 钉住源状态 open").contains("status");
        assertThat(call.params()).contains("open");
        verify(draftService).cancelPendingByRequest(REQUEST_ID);
        verify(recordService).failPendingByRequest(eq(REQUEST_ID), anyString());
    }

    @Test
    @DisplayName("reopen：closed -> draft，且显式把 status/close_reason/closed_at 三个字段都写进 SET")
    void reopenClearsCloseTraces() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        when(mapper.selectById(REQUEST_ID)).thenReturn(submittableEntity("closed"));
        stubCasMatched(mapper);
        HrRequestService service = new HrRequestService(mapper, mock(PublishDraftService.class), mock(PublishRecordService.class), mock(DomainEventService.class));

        service.reopen(REQUEST_ID, OPERATOR_ID);

        // reopen 必须走 SET 显式置 null（updateById 会忽略 null 字段，清不掉关闭痕迹），
        // 且 WHERE 钉住 closed 以防并发重复 reopen。
        UpdateCall call = captureCas(mapper);
        assertThat(call.sqlSet())
                .as("必须显式清空关闭痕迹，否则 reopen 后仍显示 closed 元数据")
                .contains("status")
                .contains("close_reason")
                .contains("closed_at");
        assertThat(call.sqlSegment()).contains("status");
        assertThat(call.params()).contains("closed").contains("draft");
    }

    // ==================== 3. 转移合法但业务校验拦下 ====================

    @Test
    @DisplayName("submit：转移合法但必填不全 -> 400（checkSubmittable 兜底）")
    void submitRejectedWhenFieldsIncomplete() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        HrRequest incomplete = new HrRequest();
        incomplete.setId(REQUEST_ID);
        incomplete.setStatus("draft");
        incomplete.setTitle("   ");          // 空白不算有值
        incomplete.setDeptName("研发中心");
        incomplete.setHeadcountTotal(1);
        incomplete.setJobDescription(null);  // 缺失
        when(mapper.selectById(REQUEST_ID)).thenReturn(incomplete);
        HrRequestService service = new HrRequestService(mapper, mock(PublishDraftService.class), mock(PublishRecordService.class), mock(DomainEventService.class));

        assertThatThrownBy(() -> service.submit(REQUEST_ID, OPERATOR_ID))
                .isInstanceOfSatisfying(MyException.class, ex -> assertThat(ex.getCode()).isEqualTo(400));
    }

    @Test
    @DisplayName("close：状态 open（转移合法）但关闭原因非法 -> 400")
    void closeRejectedWhenReasonInvalid() {
        HrRequestService service = newService("open");

        assertThatThrownBy(() -> service.close(REQUEST_ID, "随便写的", OPERATOR_ID))
                .isInstanceOfSatisfying(MyException.class, ex -> assertThat(ex.getCode()).isEqualTo(400));
    }

    // ==================== 4. 招满自动关闭（§5.1 headcount 规则） ====================

    @Test
    @DisplayName("updateHeadcount：open + autoClose + filled>=total -> 自动关闭(filled) 并联动作废")
    void autoClosesWhenHeadcountSaturated() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        HrRequest entity = submittableEntity("open");
        entity.setHeadcountTotal(2);
        entity.setHeadcountFilled(1);
        entity.setAutoClose(true);
        when(mapper.selectById(REQUEST_ID)).thenReturn(entity);
        stubCasMatched(mapper);
        PublishDraftService draftService = mock(PublishDraftService.class);
        PublishRecordService recordService = mock(PublishRecordService.class);
        HrRequestService service = new HrRequestService(mapper, draftService, recordService, mock(DomainEventService.class));

        service.updateHeadcount(REQUEST_ID, 2, OPERATOR_ID);

        UpdateCall call = captureCas(mapper);
        assertThat(call.sqlSet())
                .contains("headcount_filled").contains("status")
                .contains("close_reason").contains("closed_at");
        assertThat(call.params()).contains("closed").contains("filled").contains(2);
        assertThat(call.params()).as("自动关闭是 open -> closed，WHERE 必须钉住 open").contains("open");
        verify(draftService).cancelPendingByRequest(REQUEST_ID);
        verify(recordService).failPendingByRequest(eq(REQUEST_ID), anyString());
    }

    @Test
    @DisplayName("updateHeadcount：filled < total -> 只窄写入 headcount_filled，不碰状态、无联动")
    void staysOpenWhenHeadcountNotSaturated() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        HrRequest entity = submittableEntity("open");
        entity.setHeadcountTotal(3);
        entity.setAutoClose(true);
        when(mapper.selectById(REQUEST_ID)).thenReturn(entity);
        PublishDraftService draftService = mock(PublishDraftService.class);
        HrRequestService service = new HrRequestService(mapper, draftService, mock(PublishRecordService.class), mock(DomainEventService.class));

        service.updateHeadcount(REQUEST_ID, 2, OPERATOR_ID);

        UpdateCall call = captureCas(mapper);
        assertThat(call.sqlSet()).contains("headcount_filled");
        assertThat(call.sqlSet())
                .as("未招满时不得顺带改状态（整实体回写会覆盖并发改动）")
                .doesNotContain("status")
                .doesNotContain("close_reason");
        assertThat(call.sqlSegment())
                .as("修正已入职数在任何状态下都应可做，故 WHERE 只钉 id")
                .doesNotContain("status");
        verify(draftService, never()).cancelPendingByRequest(any());
    }

    @Test
    @DisplayName("updateHeadcount：autoClose=false 时招满也不自动关闭（开关生效）")
    void doesNotAutoCloseWhenSwitchOff() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        HrRequest entity = submittableEntity("open");
        entity.setHeadcountTotal(2);
        entity.setAutoClose(false);
        when(mapper.selectById(REQUEST_ID)).thenReturn(entity);
        PublishDraftService draftService = mock(PublishDraftService.class);
        HrRequestService service = new HrRequestService(mapper, draftService, mock(PublishRecordService.class), mock(DomainEventService.class));

        service.updateHeadcount(REQUEST_ID, 5, OPERATOR_ID);

        UpdateCall call = captureCas(mapper);
        assertThat(call.sqlSet())
                .as("开关关闭时超员也不得自动关闭")
                .contains("headcount_filled")
                .doesNotContain("close_reason");
        verify(draftService, never()).cancelPendingByRequest(any());
    }

    // ==================== 5. 并发冲突（P1-1 乐观并发控制） ====================

    @Test
    @DisplayName("approve 并发冲突：CAS 未命中 -> 409，且绝不渲染草稿（防重复 pending 草稿）")
    void approveConflictRejectsAndSkipsRendering() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        when(mapper.selectById(REQUEST_ID)).thenReturn(submittableEntity("pending_approval"));
        stubCasConflict(mapper);
        PublishDraftService draftService = mock(PublishDraftService.class);
        HrRequestService service = new HrRequestService(mapper, draftService, mock(PublishRecordService.class), mock(DomainEventService.class));

        assertThatThrownBy(() -> service.approve(REQUEST_ID, OPERATOR_ID))
                .as("第二个并发 approve 必须失败，否则同一 (request, channel) 会出现两条 pending 草稿")
                .isInstanceOfSatisfying(MyException.class, ex -> assertThat(ex.getCode()).isEqualTo(409));

        verify(draftService, never()).renderForRequest(any());
    }

    @Test
    @DisplayName("close 并发冲突：CAS 未命中 -> 409，且不对草稿/台账联动作废")
    void closeConflictRejectsAndSkipsCascade() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        when(mapper.selectById(REQUEST_ID)).thenReturn(submittableEntity("open"));
        stubCasConflict(mapper);
        PublishDraftService draftService = mock(PublishDraftService.class);
        PublishRecordService recordService = mock(PublishRecordService.class);
        HrRequestService service = new HrRequestService(mapper, draftService, recordService, mock(DomainEventService.class));

        assertThatThrownBy(() -> service.close(REQUEST_ID, "cancelled", OPERATOR_ID))
                .isInstanceOfSatisfying(MyException.class, ex -> assertThat(ex.getCode()).isEqualTo(409));

        verify(draftService, never()).cancelPendingByRequest(any());
        verify(recordService, never()).failPendingByRequest(any(), anyString());
    }

    @Test
    @DisplayName("submit 并发冲突：CAS 未命中 -> 409（两个 HR 同时提交只成功一个）")
    void submitConflictRejectsSecondWriter() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        when(mapper.selectById(REQUEST_ID)).thenReturn(submittableEntity("draft"));
        stubCasConflict(mapper);
        HrRequestService service = new HrRequestService(mapper, mock(PublishDraftService.class), mock(PublishRecordService.class), mock(DomainEventService.class));

        assertThatThrownBy(() -> service.submit(REQUEST_ID, OPERATOR_ID))
                .isInstanceOfSatisfying(MyException.class, ex -> assertThat(ex.getCode()).isEqualTo(409));
    }

    @Test
    @DisplayName("CAS 的 WHERE 必须同时钉住 id 与源状态（并发保护的全部依据）")
    void casWherePinsIdAndSourceStatus() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        when(mapper.selectById(REQUEST_ID)).thenReturn(submittableEntity("closed"));
        stubCasMatched(mapper);
        HrRequestService service = new HrRequestService(mapper, mock(PublishDraftService.class), mock(PublishRecordService.class), mock(DomainEventService.class));

        service.reopen(REQUEST_ID, OPERATOR_ID);

        UpdateCall call = captureCas(mapper);
        assertThat(call.sqlSegment())
                .as("WHERE 缺了 status 就退化成无条件更新，并发保护失效")
                .contains("id")
                .contains("status");
        assertThat(call.params()).contains(REQUEST_ID).contains("closed");
    }

    // ==================== 6. 领域事件（P1-2） ====================

    @Test
    @DisplayName("事件：submit 成功 -> 发 hr_request.submitted，带源/目标状态与操作人")
    void emitsSubmittedEvent() {
        HrRequestMapper mapper = mockHrMapperMatched("draft");
        DomainEventService events = mock(DomainEventService.class);
        HrRequestService service = service(mapper, events);

        service.submit(REQUEST_ID, OPERATOR_ID);

        verify(events).hrRequestTransition(DomainEventTypes.HR_REQUEST_SUBMITTED,
                REQUEST_ID, "REQ-20260916-0007", "draft", "pending_approval", OPERATOR_ID);
    }

    @Test
    @DisplayName("事件：approve 发 hr_request.approved，close 发 hr_request.closed（类型可区分）")
    void emitsDistinctEventTypesPerAction() {
        HrRequestMapper approveMapper = mockHrMapperMatched("pending_approval");
        DomainEventService approveEvents = mock(DomainEventService.class);
        service(approveMapper, approveEvents).approve(REQUEST_ID, OPERATOR_ID);
        verify(approveEvents).hrRequestTransition(DomainEventTypes.HR_REQUEST_APPROVED,
                REQUEST_ID, "REQ-20260916-0007", "pending_approval", "open", OPERATOR_ID);

        HrRequestMapper closeMapper = mockHrMapperMatched("open");
        DomainEventService closeEvents = mock(DomainEventService.class);
        service(closeMapper, closeEvents).close(REQUEST_ID, "cancelled", OPERATOR_ID);
        verify(closeEvents).hrRequestTransition(DomainEventTypes.HR_REQUEST_CLOSED,
                REQUEST_ID, "REQ-20260916-0007", "open", "closed", OPERATOR_ID);
    }

    @Test
    @DisplayName("事件：招满自动关闭发 hr_request.auto_closed（与人工 close 区分，便于口径拆分）")
    void autoCloseEmitsDedicatedEventType() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        HrRequest entity = submittableEntity("open");
        entity.setHeadcountTotal(2);
        entity.setAutoClose(true);
        when(mapper.selectById(REQUEST_ID)).thenReturn(entity);
        stubCasMatched(mapper);
        DomainEventService events = mock(DomainEventService.class);
        HrRequestService service = service(mapper, events);

        service.updateHeadcount(REQUEST_ID, 2, OPERATOR_ID);

        verify(events).hrRequestTransition(DomainEventTypes.HR_REQUEST_AUTO_CLOSED,
                REQUEST_ID, "REQ-20260916-0007", "open", "closed", OPERATOR_ID);
    }

    @Test
    @DisplayName("事件：只修正入职数、状态未变 -> 不发转移事件（避免污染状态口径）")
    void noEventWhenStatusUnchanged() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        HrRequest entity = submittableEntity("open");
        entity.setHeadcountTotal(3);
        entity.setAutoClose(true);
        when(mapper.selectById(REQUEST_ID)).thenReturn(entity);
        DomainEventService events = mock(DomainEventService.class);
        HrRequestService service = service(mapper, events);

        service.updateHeadcount(REQUEST_ID, 2, OPERATOR_ID);

        verify(events, never()).hrRequestTransition(any(), any(), any(), any(), any(), any());
    }

    @Test
    @DisplayName("事件：CAS 未命中（转移没生效）时绝不发事件——否则会出现「有事件无状态」")
    void noEventWhenCasConflict() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        when(mapper.selectById(REQUEST_ID)).thenReturn(submittableEntity("draft"));
        stubCasConflict(mapper);
        DomainEventService events = mock(DomainEventService.class);
        HrRequestService service = service(mapper, events);

        assertThatThrownBy(() -> service.submit(REQUEST_ID, OPERATOR_ID))
                .isInstanceOfSatisfying(MyException.class, ex -> assertThat(ex.getCode()).isEqualTo(409));

        verify(events, never()).hrRequestTransition(any(), any(), any(), any(), any(), any());
    }

    // ==================== helpers ====================

    /** 一个「CAS 命中」的映射器，实体处于给定状态 */
    private HrRequestMapper mockHrMapperMatched(String status) {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        when(mapper.selectById(REQUEST_ID)).thenReturn(submittableEntity(status));
        stubCasMatched(mapper);
        return mapper;
    }

    /** 只关心事件断言的用例：其余协作对象一律 mock */
    private HrRequestService service(HrRequestMapper mapper, DomainEventService events) {
        return new HrRequestService(mapper, mock(PublishDraftService.class), mock(PublishRecordService.class), events);
    }

    private HrRequestService newService(String fromStatus) {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        HrRequest entity = submittableEntity(fromStatus);
        when(mapper.selectById(REQUEST_ID)).thenReturn(entity);
        stubCasMatched(mapper);
        return new HrRequestService(mapper, mock(PublishDraftService.class), mock(PublishRecordService.class), mock(DomainEventService.class));
    }

    /** CAS 命中（受影响 1 行）：模拟「状态未被并发改动」的正常路径 */
    private void stubCasMatched(HrRequestMapper mapper) {
        when(mapper.update(isNull(), ArgumentMatchers.<Wrapper<HrRequest>>any())).thenReturn(1);
    }

    /** CAS 未命中（受影响 0 行）：模拟「状态已被其他请求抢先改变」的并发路径 */
    private void stubCasConflict(HrRequestMapper mapper) {
        when(mapper.update(isNull(), ArgumentMatchers.<Wrapper<HrRequest>>any())).thenReturn(0);
    }

    /** 捕获一次条件更新调用：SET 子句、WHERE 子句与全部绑定参数 */
    private UpdateCall captureCas(HrRequestMapper mapper) {
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Wrapper<HrRequest>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(mapper).update(isNull(), captor.capture());
        LambdaUpdateWrapper<HrRequest> wrapper = (LambdaUpdateWrapper<HrRequest>) captor.getValue();
        // 不能用 List.copyOf：close/reopen 会显式绑定 null（清空关闭痕迹），copyOf 会 NPE
        return new UpdateCall(wrapper.getSqlSet(), wrapper.getSqlSegment(),
                new ArrayList<>(wrapper.getParamNameValuePairs().values()));
    }

    /**
     * 一次 UPDATE 的可观测面：SET 子句 / WHERE 子句 / 绑定参数。
     *
     * <p>CAS 设计下「要求数据库做什么」就体现在这三者上。相比读回 mock 的 selectById
     * （返回的是测试自己塞进去的静态对象，断言等于在测 mock），直接断言下发的语句
     * 才是对真实意图的检验。</p>
     */
    private record UpdateCall(String sqlSet, String sqlSegment, List<Object> params) {
    }

    /** 一个「转移合法且必填完整」的实体，使矩阵测试只检验状态维度 */
    private HrRequest submittableEntity(String status) {
        HrRequest e = new HrRequest();
        e.setId(REQUEST_ID);
        e.setRequestNo("REQ-20260916-0007");
        e.setTitle("Java 后端工程师");
        e.setDeptName("研发中心");
        e.setHeadcountTotal(2);
        e.setHeadcountFilled(0);
        e.setJobDescription("负责 recruit-platform 后端模块设计与开发");
        e.setStatus(status);
        return e;
    }

    private HrRequestVO invoke(HrRequestService service, String action, Long id) {
        return switch (action) {
            case "submit" -> service.submit(id, OPERATOR_ID);
            case "approve" -> service.approve(id, OPERATOR_ID);
            case "reject" -> service.reject(id, "岗位要求调整", OPERATOR_ID);
            case "close" -> service.close(id, "cancelled", OPERATOR_ID);
            case "reopen" -> service.reopen(id, OPERATOR_ID);
            default -> throw new IllegalArgumentException("未知 action: " + action);
        };
    }
}
