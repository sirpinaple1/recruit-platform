package com.recruit.service;

import com.recruit.dto.HrRequestSaveDTO;
import com.recruit.entity.HrRequest;
import com.recruit.mapper.HrRequestMapper;
import com.recruit.support.MybatisPlusTestSupport;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 需求编号生成测试（P1-3）。
 *
 * <p><b>背景</b>：编号 {@code REQ-YYYYMMDD-XXXX} 的日期部分原先取 UTC 日期。CST 00:00–08:00
 * 恰好落在 UTC 的前一天，这段时间建的单号会显示成「昨天」，与 HR 的当天认知冲突。
 * 修法是改用北京时区取日期（时间列本身仍存 UTC，互不影响）。</p>
 *
 * <p><b>关于验证强度</b>：本测试由两部分组成——① 直接断言 {@code NUMBERING_ZONE} 常量，
 * 把「用北京时区编号」这个决策钉住；② 走完整 {@code create()} 路径断言编号格式与序号。
 * 之所以不写「冻结时钟」的完全行为化断言，是因为 {@code LocalDate.now(zone)} 读系统时钟、
 * 当前不可注入；要真正做到需要引入可注入 Clock（已记为 P2 的确定性时间改造）。
 * 因此第 ① 条是决策守卫而非行为验证——这一点如实标注，不假装它覆盖了时钟逻辑。</p>
 */
class HrRequestNumberingTest {

    private static final Long REQUEST_ID = 1001L;

    /** REQ- + 8 位日期 + - + 4 位序号 */
    private static final Pattern REQUEST_NO_PATTERN = Pattern.compile("^REQ-(\\d{8})-(\\d{4})$");

    @BeforeAll
    static void bootstrapMybatisPlus() {
        MybatisPlusTestSupport.initTableInfo(HrRequest.class);
    }

    @Test
    @DisplayName("决策守卫：编号日期基准必须是 Asia/Shanghai（改回 UTC 即失败）")
    void numberingZoneIsShanghai() {
        assertThat(HrRequestService.NUMBERING_ZONE)
                .as("单号是给人看的，必须按北京时区取日期；改回 UTC 会让凌晨建的单显示成前一天")
                .isEqualTo(ZoneId.of("Asia/Shanghai"));
    }

    @Test
    @DisplayName("首个编号：REQ-<北京当日>-0001，且日期部分与北京日期一致")
    void firstRequestNoUsesShanghaiDate() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        // 当日还没有任何单号
        when(mapper.selectOne(any())).thenReturn(null);
        when(mapper.insert(any(HrRequest.class))).thenAnswer(inv -> {
            inv.<HrRequest>getArgument(0).setId(REQUEST_ID);
            return 1;
        });
        when(mapper.selectById(REQUEST_ID)).thenReturn(new HrRequest());
        HrRequestService service = service(mapper);

        service.create(dto(), REQUEST_ID);

        String requestNo = captureInsertedRequestNo(mapper);
        assertThat(requestNo).matches(REQUEST_NO_PATTERN);
        assertThat(datePartOf(requestNo))
                .as("日期部分应等于北京时区的当前日期")
                .isEqualTo(LocalDate.now(ZoneId.of("Asia/Shanghai")).format(DateTimeFormatter.BASIC_ISO_DATE));
    }

    @Test
    @DisplayName("序号递增：当日已有 0007 -> 下一个是 0008（补零到 4 位）")
    void sequenceIncrementsFromDailyMax() {
        HrRequestMapper mapper = mock(HrRequestMapper.class);
        HrRequest existing = new HrRequest();
        existing.setRequestNo("REQ-" + todayShanghai() + "-0007");
        when(mapper.selectOne(any())).thenReturn(existing);
        when(mapper.insert(any(HrRequest.class))).thenAnswer(inv -> {
            inv.<HrRequest>getArgument(0).setId(REQUEST_ID);
            return 1;
        });
        when(mapper.selectById(REQUEST_ID)).thenReturn(new HrRequest());
        HrRequestService service = service(mapper);

        service.create(dto(), REQUEST_ID);

        assertThat(captureInsertedRequestNo(mapper)).isEqualTo("REQ-" + todayShanghai() + "-0008");
    }

    // ==================== helpers ====================

    private HrRequestService service(HrRequestMapper mapper) {
        return new HrRequestService(mapper, mock(PublishDraftService.class), mock(PublishRecordService.class),
                mock(DomainEventService.class));
    }

    private String captureInsertedRequestNo(HrRequestMapper mapper) {
        ArgumentCaptor<HrRequest> captor = ArgumentCaptor.forClass(HrRequest.class);
        verify(mapper).insert(captor.capture());
        return captor.getValue().getRequestNo();
    }

    private String todayShanghai() {
        return LocalDate.now(ZoneId.of("Asia/Shanghai")).format(DateTimeFormatter.BASIC_ISO_DATE);
    }

    private String datePartOf(String requestNo) {
        Matcher matcher = REQUEST_NO_PATTERN.matcher(requestNo);
        assertThat(matcher.matches()).as("编号格式必须是 REQ-<8位日期>-<4位序号>").isTrue();
        return matcher.group(1);
    }

    private HrRequestSaveDTO dto() {
        HrRequestSaveDTO dto = new HrRequestSaveDTO();
        dto.setTitle("Java 后端工程师");
        dto.setDeptName("研发中心");
        dto.setHeadcountTotal(2);
        dto.setJobDescription("负责 recruit-platform 后端模块设计与开发");
        return dto;
    }
}
