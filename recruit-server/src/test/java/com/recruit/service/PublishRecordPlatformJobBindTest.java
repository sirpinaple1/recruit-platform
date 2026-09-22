package com.recruit.service;

import com.recruit.common.MyException;
import com.recruit.dto.RecordReportDTO;
import com.recruit.entity.Channel;
import com.recruit.entity.PublishRecord;
import com.recruit.mapper.ChannelMapper;
import com.recruit.mapper.HrRequestMapper;
import com.recruit.mapper.PublishDraftMapper;
import com.recruit.mapper.PublishRecordMapper;
import com.recruit.support.MybatisPlusTestSupport;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 人工绑定平台岗位（路径 B）的规则测试。
 *
 * <p>出处：{@code docs/design/candidate-position-linking.md} 路径 B。本类锁定的核心是
 * **A 与 B 的边界**，而不是绑定功能本身：</p>
 *
 * <table border="1">
 *   <tr><th>规则</th><th>为什么必须有</th></tr>
 *   <tr><td>自动<b>不</b>覆盖人工；人工<b>可</b>覆盖任何状态</td>
 *       <td>反过来（自动能覆盖人工）会让 HR 的纠正被下一次上报静默改回 —— 人做了决定却被机器推翻</td></tr>
 *   <tr><td>一个平台岗位只能被一条台账持有</td>
 *       <td>否则同一岗位的投递会被解析到两个需求单，投递数据直接分裂</td></tr>
 *   <tr><td>改绑时<b>旧岗位也要</b>级联</td>
 *       <td>只刷新岗位的话，旧岗位的投递会留在旧需求单上，形成「同一岗位归属分裂」</td></tr>
 *   <tr><td>只有 published 台账可绑定</td>
 *       <td>否则「是否已发布」出现两个真源（status 与 platform_job_id）</td></tr>
 *   <tr><td>解除绑定把三列一起清</td>
 *       <td>只清值会留下「来源=manual 但没有值」的半状态，后续判断全部失真</td></tr>
 * </table>
 *
 * <p>纯单测（不连库）：MyBatis-Plus 实体元数据由 {@link MybatisPlusTestSupport} 引导，
 * mapper 与级联服务全部 Mockito 提供。</p>
 */
class PublishRecordPlatformJobBindTest {

    private static final Long RECORD_ID = 5001L;
    private static final Long OTHER_RECORD_ID = 5002L;
    private static final Long CHANNEL_ID = 8001L;
    private static final Long REQUEST_ID = 9001L;
    private static final Long OTHER_REQUEST_ID = 9002L;
    private static final Long OPERATOR_ID = 7001L;
    private static final String JOB_NEW = "575500411";
    private static final String JOB_OLD = "575500400";

    /** bindPlatformJob 会构造 LambdaUpdateWrapper / LambdaQueryWrapper<PublishRecord> */
    @BeforeAll
    static void bootstrapMybatisPlus() {
        MybatisPlusTestSupport.initTableInfo(PublishRecord.class);
    }

    // ==================== 1. 只有 published 才能绑定 ====================

    @Test
    @DisplayName("pending 台账拒绝绑定：避免「是否已发布」出现两个真源")
    void pendingRecordCannotBind() {
        Fixture f = fixture(record("pending", null, null));

        assertThatThrownBy(() -> f.service.bindPlatformJob(RECORD_ID, JOB_NEW, OPERATOR_ID))
                .isInstanceOfSatisfying(MyException.class, ex -> {
                    assertThat(ex.getCode()).isEqualTo(400);
                    assertThat(ex.getMessage()).as("提示里必须给出出口，否则 HR 无从下手")
                            .contains("标记为已发布");
                });
        verify(f.recordMapper, never()).update(any(), any());
        verify(f.applications, never()).recomputeByPlatformJob(any(), any());
    }

    @Test
    @DisplayName("台账不存在：404")
    void missingRecordIs404() {
        PublishRecordMapper mapper = mock(PublishRecordMapper.class);
        when(mapper.selectById(RECORD_ID)).thenReturn(null);
        PublishRecordService service = newService(mapper, mock(CandidateApplicationService.class));

        assertThatThrownBy(() -> service.bindPlatformJob(RECORD_ID, JOB_NEW, OPERATOR_ID))
                .isInstanceOfSatisfying(MyException.class,
                        ex -> assertThat(ex.getCode()).isEqualTo(404));
    }

    // ==================== 2. 冲突：一个岗位只能属于一个需求单 ====================

    @Test
    @DisplayName("岗位已被别的台账持有：409，且不做任何写入与级联")
    void conflictingJobIs409() {
        Fixture f = fixture(record("published", null, null));
        when(f.recordMapper.selectList(any())).thenReturn(List.of(recordOf(OTHER_RECORD_ID, JOB_NEW)));

        assertThatThrownBy(() -> f.service.bindPlatformJob(RECORD_ID, JOB_NEW, OPERATOR_ID))
                .isInstanceOfSatisfying(MyException.class, ex -> {
                    assertThat(ex.getCode()).isEqualTo(409);
                    assertThat(ex.getMessage()).contains(String.valueOf(OTHER_RECORD_ID));
                });
        verify(f.recordMapper, never()).update(any(), any());
        verify(f.applications, never()).recomputeByPlatformJob(any(), any());
    }

    @Test
    @DisplayName("岗位本来就绑在自己身上：不算冲突，正常走写入")
    void ownJobIsNotAConflict() {
        Fixture f = fixture(record("published", JOB_OLD, null));
        when(f.recordMapper.selectList(any())).thenReturn(List.of(recordOf(RECORD_ID, JOB_OLD)));

        assertThatCode(() -> f.service.bindPlatformJob(RECORD_ID, JOB_OLD, OPERATOR_ID))
                .doesNotThrowAnyException();
    }

    // ==================== 3. A 与 B 的边界 ====================

    @Test
    @DisplayName("人工覆盖自动值：值变了就写 manual（B 存在的意义）")
    void manualOverwritesAutoValue() {
        Fixture f = fixture(record("published", JOB_OLD, "auto"));

        f.service.bindPlatformJob(RECORD_ID, JOB_NEW, OPERATOR_ID);

        verify(f.recordMapper, times(1)).update(any(), any());
        verify(f.applications).recomputeByPlatformJob(CHANNEL_ID, JOB_NEW);
    }

    @Test
    @DisplayName("人工确认自动值（值没变）：不早退，仍把来源升格为 manual")
    void manualConfirmsAutoValue() {
        Fixture f = fixture(record("published", JOB_NEW, "auto"));

        f.service.bindPlatformJob(RECORD_ID, JOB_NEW, OPERATOR_ID);

        verify(f.recordMapper, times(1)).update(any(), any());
        // 值未变化，旧岗位与新岗位相同 → 只需刷一次
        verify(f.applications, times(1)).recomputeByPlatformJob(CHANNEL_ID, JOB_NEW);
    }

    @Test
    @DisplayName("已是同一人工绑定：幂等返回，不产生写入与无意义级联")
    void repeatedManualBindIsIdempotent() {
        Fixture f = fixture(record("published", JOB_NEW, "manual"));

        f.service.bindPlatformJob(RECORD_ID, JOB_NEW, OPERATOR_ID);

        verify(f.recordMapper, never()).update(any(), any());
        verify(f.applications, never()).recomputeByPlatformJob(any(), any());
    }

    // ==================== 4. 级联双向 ====================

    @Test
    @DisplayName("改绑：旧岗位与新岗位都要级联（只刷新岗位会造成归属分裂）")
    void rebindCascadesBothJobs() {
        Fixture f = fixture(record("published", JOB_OLD, "auto"));

        f.service.bindPlatformJob(RECORD_ID, JOB_NEW, OPERATOR_ID);

        verify(f.applications).recomputeByPlatformJob(CHANNEL_ID, JOB_OLD);
        verify(f.applications).recomputeByPlatformJob(CHANNEL_ID, JOB_NEW);
    }

    @Test
    @DisplayName("解除绑定：清空岗位 → 只刷旧岗位，其投递回落为未归类")
    void unbindCascadesOldJobOnly() {
        Fixture f = fixture(record("published", JOB_OLD, "auto"));

        f.service.bindPlatformJob(RECORD_ID, null, OPERATOR_ID);

        verify(f.recordMapper, times(1)).update(any(), any());
        verify(f.applications, times(1)).recomputeByPlatformJob(CHANNEL_ID, JOB_OLD);
    }

    @Test
    @DisplayName("空白串等同解除绑定（不会被当成一个叫「 」的岗位）")
    void blankMeansUnbind() {
        Fixture f = fixture(record("published", JOB_OLD, "manual"));
        when(f.recordMapper.selectList(any())).thenReturn(List.of());

        f.service.bindPlatformJob(RECORD_ID, "   ", OPERATOR_ID);

        verify(f.recordMapper, times(1)).update(any(), any());
        verify(f.applications, times(1)).recomputeByPlatformJob(CHANNEL_ID, JOB_OLD);
    }

    // ==================== 5. 静默失效守卫：非采集渠道 ====================

    @Test
    @DisplayName("非采集渠道（如 mock_demo）拒绝绑定：否则「已关联」是假象，投递永远归不了类")
    void nonCapturableChannelIsRejected() {
        Fixture f = fixture(record("published", null, null), "mock_demo");

        assertThatThrownBy(() -> f.service.bindPlatformJob(RECORD_ID, JOB_NEW, OPERATOR_ID))
                .isInstanceOfSatisfying(MyException.class, ex -> {
                    assertThat(ex.getCode()).isEqualTo(400);
                    assertThat(ex.getMessage()).as("必须点明后果与原因，否则人会以为是系统 bug")
                            .contains("mock_demo")
                            .contains("不会生效");
                });
        verify(f.recordMapper, never()).update(any(), any());
        verify(f.applications, never()).recomputeByPlatformJob(any(), any());
    }

    @Test
    @DisplayName("解除绑定不受渠道守卫限制：清掉一个无效映射永远是合法的")
    void unbindAllowedEvenOnNonCapturableChannel() {
        Fixture f = fixture(record("published", JOB_OLD, "auto"), "mock_demo");

        assertThatCode(() -> f.service.bindPlatformJob(RECORD_ID, null, OPERATOR_ID))
                .doesNotThrowAnyException();
        verify(f.recordMapper, times(1)).update(any(), any());
    }

    @Test
    @DisplayName("非采集渠道：**回填**带 platformJobId 同样被拒（两条写入路径共用同一守卫）")
    void reportRejectsJobIdOnNonCapturableChannel() {
        Fixture f = fixture(record("pending", null, null), "mock_demo");
        RecordReportDTO dto = new RecordReportDTO();
        dto.setStatus("published");
        dto.setPlatformJobId(JOB_NEW);

        assertThatThrownBy(() -> f.service.report(RECORD_ID, dto, OPERATOR_ID))
                .isInstanceOfSatisfying(MyException.class,
                        ex -> assertThat(ex.getCode()).isEqualTo(400));
        verify(f.recordMapper, never()).update(any(), any());
    }

    @Test
    @DisplayName("采集渠道回填带 platformJobId：正常写入 auto 映射（与上一条形成对照）")
    void reportAcceptsJobIdOnCapturableChannel() {
        Fixture f = fixture(record("pending", null, null), "boss");
        RecordReportDTO dto = new RecordReportDTO();
        dto.setStatus("published");
        dto.setPlatformJobId(JOB_NEW);

        f.service.report(RECORD_ID, dto, OPERATOR_ID);

        verify(f.recordMapper, times(1)).update(any(), any());
        verify(f.applications).recomputeByPlatformJob(CHANNEL_ID, JOB_NEW);
    }

    // ==================== 构造辅助 ====================

    private record Fixture(PublishRecordService service,
                           PublishRecordMapper recordMapper,
                           CandidateApplicationService applications) {
    }

    /** 一条「已发布但尚未绑定岗位」的台账 + 全套 mock（含 getDetail 所需的读路径） */
    private Fixture fixture(PublishRecord record) {
        return fixture(record, "boss");
    }

    /** 同上，但可指定台账所属渠道的 code（用于验证「非采集渠道」守卫） */
    private Fixture fixture(PublishRecord record, String channelCode) {
        PublishRecordMapper recordMapper = mock(PublishRecordMapper.class);
        CandidateApplicationService applications = mock(CandidateApplicationService.class);
        ChannelMapper channelMapper = mock(ChannelMapper.class);
        Channel channel = new Channel();
        channel.setId(CHANNEL_ID);
        channel.setCode(channelCode);
        when(channelMapper.selectById(CHANNEL_ID)).thenReturn(channel);
        when(recordMapper.selectById(record.getId())).thenReturn(record);
        when(recordMapper.selectList(any())).thenReturn(List.of());
        when(recordMapper.update(any(), any())).thenReturn(1);
        when(applications.recomputeByPlatformJob(any(), any())).thenReturn(0);
        return new Fixture(newService(recordMapper, channelMapper, applications), recordMapper, applications);
    }

    private PublishRecordService newService(PublishRecordMapper recordMapper,
                                           CandidateApplicationService applications) {
        return newService(recordMapper, mock(ChannelMapper.class), applications);
    }

    private PublishRecordService newService(PublishRecordMapper recordMapper,
                                           ChannelMapper channelMapper,
                                           CandidateApplicationService applications) {
        return new PublishRecordService(recordMapper, mock(PublishDraftMapper.class),
                channelMapper, mock(HrRequestMapper.class), applications);
    }

    private PublishRecord record(String status, String platformJobId, String bindSource) {
        PublishRecord r = new PublishRecord();
        r.setId(RECORD_ID);
        r.setDraftId(1L);
        r.setRequestId(REQUEST_ID);
        r.setChannelId(CHANNEL_ID);
        r.setStatus(status);
        r.setPlatformJobId(platformJobId);
        r.setPlatformJobBindSource(bindSource);
        return r;
    }

    private PublishRecord recordOf(Long id, String platformJobId) {
        PublishRecord r = new PublishRecord();
        r.setId(id);
        r.setRequestId(OTHER_REQUEST_ID);
        r.setChannelId(CHANNEL_ID);
        r.setPlatformJobId(platformJobId);
        return r;
    }
}
