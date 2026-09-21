package com.recruit.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.recruit.common.MyException;
import com.recruit.entity.Attachment;
import com.recruit.entity.Candidate;
import com.recruit.entity.CollectAudit;
import com.recruit.entity.ResumeVersion;
import com.recruit.entity.SysUser;
import com.recruit.mapper.AttachmentMapper;
import com.recruit.mapper.CandidateMapper;
import com.recruit.mapper.CollectAuditMapper;
import com.recruit.mapper.ResumeVersionMapper;
import com.recruit.mapper.SysUserMapper;
import com.recruit.vo.AttachmentVO;
import com.recruit.vo.CandidateDetailVO;
import com.recruit.vo.CandidateVO;
import com.recruit.vo.CollectAuditVO;
import com.recruit.vo.ResumeVersionVO;
import lombok.RequiredArgsConstructor;
import lombok.extern.log4j.Log4j2;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 候选人库查询（登录态接口，中台「候选人库」页用）。
 *
 * <p>与 {@link CollectService} 分离：写入走扩展 token 鉴权，查询走中台登录态，
 * 两条链路的鉴权与权限语义完全不同，混在一个类里迟早被误用。</p>
 */
@Log4j2
@RequiredArgsConstructor
@Service
public class CandidateQueryService {

    /** 单页上限，防止前端传 size=99999 把整库拉出来 */
    private static final long MAX_PAGE_SIZE = 100;

    /** 附件「已落盘」状态（与 CollectService 里 setStatus("stored") 的口径一致） */
    private static final String STATUS_STORED = "stored";

    private final CandidateMapper candidateMapper;
    private final ResumeVersionMapper resumeVersionMapper;
    private final AttachmentMapper attachmentMapper;
    private final CollectAuditMapper collectAuditMapper;
    private final SysUserMapper sysUserMapper;
    private final AttachmentStorageService attachmentStorageService;

    /** 候选人分页（默认不展示已归并的行；可按平台/来源渠道/姓名筛选） */
    public IPage<CandidateVO> page(long page, long size, String platform, String keyword, String sourceChannel) {
        long safeSize = (size <= 0 || size > MAX_PAGE_SIZE) ? 10 : size;
        LambdaQueryWrapper<Candidate> wrapper = new LambdaQueryWrapper<Candidate>()
                .isNull(Candidate::getMergedInto)
                .eq(StringUtils.hasText(platform), Candidate::getPlatform, platform)
                .eq(StringUtils.hasText(sourceChannel), Candidate::getSourceChannel, sourceChannel)
                .like(StringUtils.hasText(keyword), Candidate::getName, keyword)
                .orderByDesc(Candidate::getLastCollectedAt);

        IPage<Candidate> result = candidateMapper.selectPage(new Page<>(page, safeSize), wrapper);
        List<Candidate> rows = result.getRecords();
        Map<Long, Long> attachmentCounts = countAttachments(rows);
        List<CandidateVO> vos = rows.stream()
                .map(c -> toVO(c, attachmentCounts.getOrDefault(c.getId(), 0L)))
                .toList();
        return new Page<CandidateVO>(result.getCurrent(), result.getSize(), result.getTotal()).setRecords(vos);
    }

    /** 候选人详情：候选人 + 简历版本 + 附件 + 采集审计（框架 §4.1 三层实体） */
    public CandidateDetailVO detail(Long candidateId) {
        Candidate candidate = candidateMapper.selectById(candidateId);
        if (candidate == null) {
            throw new MyException(404, "候选人不存在");
        }
        // 建表脚本对 merged_into 的定义就写着「非空表示本条已被合并，**查询需跟随**」。
        // 列表页已把被归并的行过滤掉，但收藏夹 / 历史 URL / 审计跳转都可能直达它 ——
        // 落到已归并行上就跟随到幸存者，而不是给用户看一个「缺附件缺版本」的残影。
        // 只跟随一跳：归并脚本保证不产生链（幸存者本身 merged_into 恒为 NULL）。
        if (candidate.getMergedInto() != null) {
            Candidate survivor = candidateMapper.selectById(candidate.getMergedInto());
            if (survivor != null) {
                log.info("候选人 {} 已归并至 {}，详情按幸存者返回", candidateId, survivor.getId());
                candidate = survivor;
                candidateId = survivor.getId();
            }
        }

        List<ResumeVersion> versions = resumeVersionMapper.selectList(new LambdaQueryWrapper<ResumeVersion>()
                .eq(ResumeVersion::getCandidateId, candidateId)
                .orderByDesc(ResumeVersion::getCollectedAt));
        List<Attachment> attachments = attachmentMapper.selectList(new LambdaQueryWrapper<Attachment>()
                .eq(Attachment::getCandidateId, candidateId)
                .orderByDesc(Attachment::getCollectedAt));
        List<CollectAudit> audits = loadAudits(candidate);

        Map<Long, String> operatorNames = loadOperatorNames(versions, attachments, audits);

        return CandidateDetailVO.builder()
                .candidate(toVO(candidate, (long) attachments.size()))
                .versions(versions.stream().map(v -> toVersionVO(v, operatorNames)).toList())
                .attachments(attachments.stream().map(a -> toAttachmentVO(a, operatorNames)).toList())
                .audits(audits.stream().map(a -> toAuditVO(a, operatorNames)).toList())
                .build();
    }

    /**
     * 采集审计：按「candidate_id **或** 该人的任一 ID 形态」取。
     *
     * <p>为什么要带上 ID 形态这一路：审计是 append-only（代码明确永不 UPDATE/DELETE），
     * 所以归并脚本**刻意不改**归并前那几条审计的 candidate_id —— 它们仍指向被兼并的行。
     * 只按 candidate_id 查就会让这段历史在中台「凭空消失」。
     * 好在审计行自带 platform_user_id，用「主键 ∪ 备用键」查就能把它们接回来。</p>
     */
    private List<CollectAudit> loadAudits(Candidate candidate) {
        List<String> ids = new ArrayList<>(2);
        ids.add(candidate.getPlatformUserId());
        if (StringUtils.hasText(candidate.getPlatformUserIdAlt())) {
            ids.add(candidate.getPlatformUserIdAlt());
        }
        return collectAuditMapper.selectList(new LambdaQueryWrapper<CollectAudit>()
                .and(w -> w.eq(CollectAudit::getCandidateId, candidate.getId())
                        .or(q -> q.eq(CollectAudit::getPlatform, candidate.getPlatform())
                                .in(CollectAudit::getPlatformUserId, ids)))
                .orderByDesc(CollectAudit::getOccurredAt));
    }

    // ==================================================================
    // 附件正文（中台内联预览 / 下载）
    // ==================================================================

    /**
     * 读取附件正文。
     *
     * <p><b>为什么不重定向到平台 URL</b>：平台的下载票据绑在 HR 本人浏览器的 cookie 与
     * 短时效上（{@code origin_ticket_expires_at} 就是为记录这点而存在）。中台页面既没有
     * 那个 cookie，也不该把平台的临时票据透给前端 —— 附件既然已经落盘，
     * 中台就自己发，这正是「入库」这条路的全部意义。</p>
     *
     * <p>三重校验缺一不可：记录存在 → status 为 stored → 文件确实在盘上。
     * 只信 status 会在「目录被手工清过 / 存储根换过」时给前端一个 500，
     * 而这两种情况在当前实现里都是真实可能发生的（见 AttachmentStorageService 的退化直写）。</p>
     */
    public AttachmentContent attachmentContent(Long attachmentId) {
        Attachment a = attachmentMapper.selectById(attachmentId);
        if (a == null) {
            throw new MyException(404, "附件不存在");
        }
        if (!STATUS_STORED.equals(a.getStatus()) || !StringUtils.hasText(a.getStorageKey())) {
            throw new MyException(404, "该附件尚未落盘（当前状态：" + a.getStatus() + "），无法打开");
        }
        if (!attachmentStorageService.exists(a.getStorageKey())) {
            throw new MyException(404, "附件文件已不在存储中（" + a.getStorageKey() + "），请让扩展重新采集该候选人");
        }
        return new AttachmentContent(
                attachmentStorageService.load(a.getStorageKey()),
                contentTypeOf(a),
                fileNameOf(a));
    }

    // ==================================================================
    // 内部
    // ==================================================================

    /** 附件是否可打开：status 是库里的意愿，exists 是盘上的事实，两者都成立才给前端开按钮 */
    private boolean isOpenable(Attachment a) {
        return STATUS_STORED.equals(a.getStatus())
                && StringUtils.hasText(a.getStorageKey())
                && attachmentStorageService.exists(a.getStorageKey());
    }

    private String contentTypeOf(Attachment a) {
        return StringUtils.hasText(a.getContentType()) ? a.getContentType() : "application/octet-stream";
    }

    private String fileNameOf(Attachment a) {
        return StringUtils.hasText(a.getFileName()) ? a.getFileName() : a.getPlatformFileId();
    }

    /** 附件正文 + 呈现元数据 */
    public record AttachmentContent(byte[] bytes, String contentType, String fileName) {
    }

    private Map<Long, Long> countAttachments(List<Candidate> rows) {
        if (rows.isEmpty()) {
            return Map.of();
        }
        List<Long> ids = rows.stream().map(Candidate::getId).toList();
        Map<Long, Long> counts = new HashMap<>();
        attachmentMapper.selectList(new LambdaQueryWrapper<Attachment>()
                        .in(Attachment::getCandidateId, ids)
                        .select(Attachment::getCandidateId))
                .forEach(a -> counts.merge(a.getCandidateId(), 1L, Long::sum));
        return counts;
    }

    /** 批量取操作人姓名，避免逐行查库（列表页 N+1） */
    private Map<Long, String> loadOperatorNames(List<ResumeVersion> versions, List<Attachment> attachments,
                                                List<CollectAudit> audits) {
        Set<Long> ids = new HashSet<>();
        versions.forEach(v -> addIfPresent(ids, v.getOperatedBy()));
        attachments.forEach(a -> addIfPresent(ids, a.getOperatedBy()));
        audits.forEach(a -> addIfPresent(ids, a.getOperatorId()));
        if (ids.isEmpty()) {
            return Map.of();
        }
        return sysUserMapper.selectBatchIds(ids).stream()
                .collect(Collectors.toMap(SysUser::getId,
                        u -> StringUtils.hasText(u.getRealName()) ? u.getRealName() : u.getUsername(),
                        (a, b) -> a));
    }

    private void addIfPresent(Set<Long> ids, Long id) {
        if (id != null) {
            ids.add(id);
        }
    }

    private CandidateVO toVO(Candidate c, Long attachmentCount) {
        return CandidateVO.builder()
                .id(String.valueOf(c.getId()))
                .platform(c.getPlatform())
                .platformUserId(c.getPlatformUserId())
                .platformUserIdAlt(c.getPlatformUserIdAlt())
                .name(c.getName())
                .currentTitle(c.getCurrentTitle())
                .expectSalary(c.getExpectSalary())
                .city(c.getCity())
                .education(c.getEducation())
                .school(c.getSchool())
                .major(c.getMajor())
                .workYear(c.getWorkYear())
                .age(c.getAge())
                .gender(c.getGender())
                .sourceChannel(c.getSourceChannel())
                .versionCount(c.getVersionCount())
                .attachmentCount(Math.toIntExact(attachmentCount))
                .mergedIntoId(c.getMergedInto() == null ? null : String.valueOf(c.getMergedInto()))
                .firstCollectedAt(c.getFirstCollectedAt())
                .lastCollectedAt(c.getLastCollectedAt())
                .build();
    }

    private ResumeVersionVO toVersionVO(ResumeVersion v, Map<Long, String> operatorNames) {
        return ResumeVersionVO.builder()
                .id(String.valueOf(v.getId()))
                .candidateId(String.valueOf(v.getCandidateId()))
                .source(v.getSource())
                .sourceApi(v.getSourceApi())
                .platformResumeId(v.getPlatformResumeId())
                .fieldsJson(v.getFieldsJson())
                .fieldCount(v.getFieldCount())
                .rawEncrypted(v.getRawEncrypted())
                .rawBytes(v.getRawBytes())
                .rawTruncated(v.getRawTruncated())
                .contentHash(v.getContentHash())
                .sourceUrl(v.getSourceUrl())
                .collectedAt(v.getCollectedAt())
                .operatedBy(v.getOperatedBy() == null ? null : String.valueOf(v.getOperatedBy()))
                .operatorName(operatorNames.get(v.getOperatedBy()))
                .build();
    }

    private AttachmentVO toAttachmentVO(Attachment a, Map<Long, String> operatorNames) {
        return AttachmentVO.builder()
                .id(String.valueOf(a.getId()))
                .candidateId(String.valueOf(a.getCandidateId()))
                .resumeVersionId(a.getResumeVersionId() == null ? null : String.valueOf(a.getResumeVersionId()))
                .platformFileId(a.getPlatformFileId())
                .fileName(a.getFileName())
                .contentType(a.getContentType())
                .bytes(a.getBytes())
                .sha256(a.getSha256())
                .status(a.getStatus())
                .failReason(a.getFailReason())
                .sourceScene(a.getSourceScene())
                .originUrl(a.getOriginUrl())
                .originTicketExpiresAt(a.getOriginTicketExpiresAt())
                .storageKey(a.getStorageKey())
                .openable(isOpenable(a))
                .collectedAt(a.getCollectedAt())
                .storedAt(a.getStoredAt())
                .operatedBy(a.getOperatedBy() == null ? null : String.valueOf(a.getOperatedBy()))
                .operatorName(operatorNames.get(a.getOperatedBy()))
                .build();
    }

    private CollectAuditVO toAuditVO(CollectAudit a, Map<Long, String> operatorNames) {
        return CollectAuditVO.builder()
                .id(String.valueOf(a.getId()))
                .action(a.getAction())
                .result(a.getResult())
                .operatorId(a.getOperatorId() == null ? null : String.valueOf(a.getOperatorId()))
                .operatorName(operatorNames.get(a.getOperatorId()))
                .platform(a.getPlatform())
                .platformUserId(a.getPlatformUserId())
                .candidateId(a.getCandidateId() == null ? null : String.valueOf(a.getCandidateId()))
                .scene(a.getScene())
                .pageUrl(a.getPageUrl())
                .sourceApi(a.getSourceApi())
                .clientNote(a.getClientNote())
                .occurredAt(a.getOccurredAt())
                .createdAt(a.getCreatedAt())
                .build();
    }
}
