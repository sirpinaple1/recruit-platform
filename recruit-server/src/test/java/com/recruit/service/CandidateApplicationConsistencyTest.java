package com.recruit.service;

import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.recruit.entity.CandidateApplication;
import com.recruit.entity.Channel;
import com.recruit.entity.PublishRecord;
import com.recruit.mapper.CandidateApplicationMapper;
import com.recruit.mapper.ChannelMapper;
import com.recruit.mapper.PublishRecordMapper;
import com.recruit.support.MybatisPlusTestSupport;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 候选人投递事实（candidate_application）的一致性测试。
 *
 * <p>出处：{@code docs/design/candidate-position-linking.md}。这几个用例锁定的不是「功能」，
 * 而是<b>四条不变式</b>——它们中的任何一条被破坏，都会产生「看得见的功能正常、数据却错了」
 * 的隐蔽故障，所以必须由测试而非人工 review 兜住：</p>
 *
 * <table border="1">
 *   <tr><th>#</th><th>不变式</th><th>破坏后的后果</th></tr>
 *   <tr><td>1</td><td>拿不到岗位 ID 就不落行</td>
 *       <td>库里出现「投了但不知投哪」的半行，「未归类」无法再用本表无行判定</td></tr>
 *   <tr><td>2</td><td>同一人 × 同一岗位不重复落行，且不改写首次投递时间</td>
 *       <td>投递事实被重复计数，「第一次投递时间」随采集次数漂移</td></tr>
 *   <tr><td>3</td><td>映射未知时 request_id 留 NULL，<b>绝不猜</b></td>
 *       <td>候选人被归到错误职位；未归类看得见，错归类看不见</td></tr>
 *   <tr><td>4</td><td>映射建立后级联重算，派生值与映射永远一致</td>
 *       <td>同一平台岗位下的投递归属分裂成两个需求单</td></tr>
 * </table>
 *
 * <p>本类为纯单测（不连库）：{@link MybatisPlusTestSupport} 补齐 MyBatis-Plus 的
 * 实体元数据缓存（Lambda wrapper 解析列名依赖它），mapper 全部由 Mockito 提供。</p>
 */
class CandidateApplicationConsistencyTest {

    private static final Long CANDIDATE_ID = 7001L;
    private static final long CHANNEL_ID = 8001L;
    private static final String PLATFORM = "boss";
    private static final String JOB_ID = "575500411";
    private static final Long REQUEST_ID = 9001L;
    private static final LocalDateTime COLLECTED_AT = LocalDateTime.of(2026, 9, 21, 5, 58, 14);

    /** 服务内部会构造 LambdaQueryWrapper / LambdaUpdateWrapper，需先引导三个实体的元数据缓存 */
    @BeforeAll
    static void bootstrapMybatisPlus() {
        MybatisPlusTestSupport.initTableInfo(CandidateApplication.class, Channel.class, PublishRecord.class);
    }

    // ==================== 1. 拿不到岗位 ID 就不落行 ====================

    @Test
    @DisplayName("岗位 ID 为空：不落行（不造「投了但不知投哪」的半行）")
    void blankJobIdWritesNothing() {
        CandidateApplicationMapper mapper = mock(CandidateApplicationMapper.class);
        CandidateApplicationService service = newService(mapper);

        assertThat(service.recordFromCollect(CANDIDATE_ID, PLATFORM, null, "hint", "chat", 1L, COLLECTED_AT))
                .as("没有岗位 ID 就没有投递事实，必须返回 null").isNull();
        assertThat(service.recordFromCollect(CANDIDATE_ID, PLATFORM, "   ", "hint", "chat", 1L, COLLECTED_AT))
                .as("空白串等同没有").isNull();

        verify(mapper, never()).insert(any(CandidateApplication.class));
    }

    // ==================== 2. 幂等：不重复落行、不改写首次时间 ====================

    @Test
    @DisplayName("重复采集同一岗位：不再 insert，且不改写已有的 applied_at")
    void duplicateCollectIsIdempotent() {
        CandidateApplicationMapper mapper = mock(CandidateApplicationMapper.class);
        CandidateApplication existing = existingApplication(REQUEST_ID, COLLECTED_AT);
        when(mapper.selectList(any())).thenReturn(List.of(existing));
        CandidateApplicationService service = newService(mapper);

        // 第二次采集：时刻更晚、hint 也不同
        CandidateApplication result = service.recordFromCollect(CANDIDATE_ID, PLATFORM, JOB_ID,
                "9月22日 沟通的职位-Java", "chat", 2L, COLLECTED_AT.plusDays(1));

        assertThat(result).as("已存在时不新建").isNull();
        verify(mapper, never()).insert(any(CandidateApplication.class));
        assertThat(existing.getAppliedAt()).as("首次投递时刻不得被后续采集改写").isEqualTo(COLLECTED_AT);
        verify(mapper, never()).updateById(any(CandidateApplication.class));
    }

    // ==================== 3. 映射未知时绝不猜 ====================

    @Test
    @DisplayName("映射不存在：新行的 request_id 留 NULL（绝不按标题/近似岗猜）")
    void unmappedJobIdLeavesRequestIdNull() {
        CandidateApplicationMapper mapper = mock(CandidateApplicationMapper.class);
        ChannelMapper channelMapper = mock(ChannelMapper.class);
        PublishRecordMapper recordMapper = mock(PublishRecordMapper.class);
        when(mapper.selectList(any())).thenReturn(List.of());
        when(channelMapper.selectList(any())).thenReturn(List.of(channel()));
        // 平台岗位没有任何台账映射
        when(recordMapper.selectList(any())).thenReturn(List.of());
        CandidateApplicationService service =
                new CandidateApplicationService(mapper, channelMapper, recordMapper);

        service.recordFromCollect(CANDIDATE_ID, PLATFORM, JOB_ID, "9月21日 沟通的职位-Java",
                "chat", 11L, COLLECTED_AT);

        ArgumentCaptor<CandidateApplication> captor = ArgumentCaptor.forClass(CandidateApplication.class);
        verify(mapper).insert(captor.capture());
        CandidateApplication saved = captor.getValue();
        assertThat(saved.getRequestId()).as("映射未知必须是 NULL，而不是猜出来的值").isNull();
        assertThat(saved.getPlatformJobId()).isEqualTo(JOB_ID);
        assertThat(saved.getPlatformJobHint()).as("平台原文提示要留下，供人工认领").isEqualTo("9月21日 沟通的职位-Java");
        assertThat(saved.getAppliedAt()).isEqualTo(COLLECTED_AT);
        assertThat(saved.getFirstResumeVersionId()).isEqualTo(11L);
    }

    @Test
    @DisplayName("映射已存在：新行直接带上 request_id（自动归类）")
    void mappedJobIdResolvesRequestId() {
        CandidateApplicationMapper mapper = mock(CandidateApplicationMapper.class);
        ChannelMapper channelMapper = mock(ChannelMapper.class);
        PublishRecordMapper recordMapper = mock(PublishRecordMapper.class);
        when(mapper.selectList(any())).thenReturn(List.of());
        when(channelMapper.selectList(any())).thenReturn(List.of(channel()));
        when(recordMapper.selectList(any())).thenReturn(List.of(recordWithJob(JOB_ID, REQUEST_ID)));
        CandidateApplicationService service =
                new CandidateApplicationService(mapper, channelMapper, recordMapper);

        service.recordFromCollect(CANDIDATE_ID, PLATFORM, JOB_ID, null, "chat", 11L, COLLECTED_AT);

        ArgumentCaptor<CandidateApplication> captor = ArgumentCaptor.forClass(CandidateApplication.class);
        verify(mapper).insert(captor.capture());
        assertThat(captor.getValue().getRequestId()).isEqualTo(REQUEST_ID);
    }

    @Test
    @DisplayName("渠道不存在：解析返回 NULL 而不是抛错（采集不能因渠道缺失而失败）")
    void unknownPlatformResolvesToNull() {
        CandidateApplicationMapper mapper = mock(CandidateApplicationMapper.class);
        ChannelMapper channelMapper = mock(ChannelMapper.class);
        when(channelMapper.selectList(any())).thenReturn(List.of());
        CandidateApplicationService service =
                new CandidateApplicationService(mapper, channelMapper, mock(PublishRecordMapper.class));

        assertThat(service.resolveRequestId("liepin", JOB_ID)).isNull();
        assertThat(service.resolveRequestId(null, JOB_ID)).isNull();
        assertThat(service.resolveRequestId(PLATFORM, "  ")).isNull();
    }

    // ==================== 4. 自愈 + 级联重算 ====================

    @Test
    @DisplayName("先采集、后建映射：再次采集时自动补上 request_id（不依赖批处理任务）")
    void existingUnmappedRowSelfHealsOnNextCollect() {
        CandidateApplicationMapper mapper = mock(CandidateApplicationMapper.class);
        ChannelMapper channelMapper = mock(ChannelMapper.class);
        PublishRecordMapper recordMapper = mock(PublishRecordMapper.class);
        CandidateApplication existing = existingApplication(null, COLLECTED_AT);
        when(mapper.selectList(any())).thenReturn(List.of(existing));
        when(channelMapper.selectList(any())).thenReturn(List.of(channel()));
        when(recordMapper.selectList(any())).thenReturn(List.of(recordWithJob(JOB_ID, REQUEST_ID)));
        CandidateApplicationService service =
                new CandidateApplicationService(mapper, channelMapper, recordMapper);

        service.recordFromCollect(CANDIDATE_ID, PLATFORM, JOB_ID, null, "chat", 11L, COLLECTED_AT);

        verify(mapper, never()).insert(any(CandidateApplication.class));
        ArgumentCaptor<CandidateApplication> captor = ArgumentCaptor.forClass(CandidateApplication.class);
        verify(mapper).updateById(captor.capture());
        assertThat(captor.getValue().getRequestId()).isEqualTo(REQUEST_ID);
    }

    @Test
    @DisplayName("映射变更：级联重算把该平台岗位下所有投递的 request_id 一起改写")
    void recomputeCascadesToAllApplicationsOfThatJob() {
        CandidateApplicationMapper mapper = mock(CandidateApplicationMapper.class);
        ChannelMapper channelMapper = mock(ChannelMapper.class);
        PublishRecordMapper recordMapper = mock(PublishRecordMapper.class);
        when(channelMapper.selectById(CHANNEL_ID)).thenReturn(channel());
        Long newRequestId = 9999L;
        when(recordMapper.selectList(any())).thenReturn(List.of(recordWithJob(JOB_ID, newRequestId)));
        when(mapper.update(any(), any())).thenReturn(3);
        CandidateApplicationService service =
                new CandidateApplicationService(mapper, channelMapper, recordMapper);

        int affected = service.recomputeByPlatformJob(CHANNEL_ID, JOB_ID);

        assertThat(affected).as("返回受影响行数").isEqualTo(3);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<LambdaUpdateWrapper<CandidateApplication>> captor =
                ArgumentCaptor.forClass(LambdaUpdateWrapper.class);
        verify(mapper, times(1)).update(any(), captor.capture());
        // ★ 顺序是有讲究的：必须先 getSqlSegment() 渲染 SQL，再读 paramNameValuePairs ★
        // LambdaUpdateWrapper 的 **WHERE 参数是惰性注册的**：实测只调 getParamNameValuePairs()
        // 只能看到 SET 的值（{"MPGENVAL1": <requestId>}），eq() 的参数要等 WHERE 片段被渲染时
        // 才写进同一张表。反过来先断言参数，会因为「参数还没注册」而误判失败 ——
        // 这不是实现缺陷，而是本类的一个调用顺序约定，写在这里免得后人再踩。
        String sql = captor.getValue().getSqlSegment();
        Map<String, Object> params = captor.getValue().getParamNameValuePairs();

        assertThat(sql)
                .as("WHERE 必须按 platform + platform_job_id 定位；实际 SQL=%s", sql)
                .contains("platform")
                .contains("platform_job_id");
        assertThat(params.values())
                .as("SET 的派生值必须是新映射解出的 request_id；实际参数=%s", params)
                .contains(newRequestId);
        assertThat(params.values())
                .as("定位参数必须是该平台与该岗位；实际参数=%s", params)
                .contains(PLATFORM, JOB_ID);
    }

    @Test
    @DisplayName("渠道行不存在：级联重算不动作且返回 0（宁可不刷，也不误刷到别家渠道）")
    void recomputeSkipsWhenChannelMissing() {
        CandidateApplicationMapper mapper = mock(CandidateApplicationMapper.class);
        ChannelMapper channelMapper = mock(ChannelMapper.class);
        when(channelMapper.selectById(CHANNEL_ID)).thenReturn(null);
        CandidateApplicationService service =
                new CandidateApplicationService(mapper, channelMapper, mock(PublishRecordMapper.class));

        assertThat(service.recomputeByPlatformJob(CHANNEL_ID, JOB_ID)).isZero();
        verify(mapper, never()).update(any(), any());
    }

    @Test
    @DisplayName("归类完成度口径：unmappedCount 统计 request_id 为 NULL 的投递")
    void unmappedCountCountsNullRequestId() {
        CandidateApplicationMapper mapper = mock(CandidateApplicationMapper.class);
        when(mapper.selectCount(any())).thenReturn(4L);
        CandidateApplicationService service = newService(mapper);

        assertThat(service.unmappedCount()).isEqualTo(4L);
        assertThat(service.total()).isEqualTo(4L);
    }

    // ==================== 构造辅助 ====================

    private CandidateApplicationService newService(CandidateApplicationMapper mapper) {
        return new CandidateApplicationService(mapper, mock(ChannelMapper.class), mock(PublishRecordMapper.class));
    }

    private Channel channel() {
        Channel c = new Channel();
        c.setId(CHANNEL_ID);
        c.setCode(PLATFORM);
        return c;
    }

    private PublishRecord recordWithJob(String platformJobId, Long requestId) {
        PublishRecord r = new PublishRecord();
        r.setId(1L);
        r.setChannelId(CHANNEL_ID);
        r.setPlatformJobId(platformJobId);
        r.setRequestId(requestId);
        return r;
    }

    private CandidateApplication existingApplication(Long requestId, LocalDateTime appliedAt) {
        CandidateApplication a = new CandidateApplication();
        a.setId(555L);
        a.setCandidateId(CANDIDATE_ID);
        a.setPlatform(PLATFORM);
        a.setPlatformJobId(JOB_ID);
        a.setRequestId(requestId);
        a.setAppliedAt(appliedAt != null ? appliedAt : LocalDateTime.now(ZoneOffset.UTC));
        return a;
    }
}
