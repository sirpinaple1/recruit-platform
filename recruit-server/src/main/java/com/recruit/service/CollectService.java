package com.recruit.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONWriter;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.recruit.common.CollectRules;
import com.recruit.common.MyException;
import com.recruit.dto.ExtAuditDTO;
import com.recruit.dto.ExtCollectSubmitDTO;
import com.recruit.entity.Attachment;
import com.recruit.entity.Candidate;
import com.recruit.entity.CollectAudit;
import com.recruit.entity.ResumeVersion;
import com.recruit.mapper.AttachmentMapper;
import com.recruit.mapper.CandidateMapper;
import com.recruit.mapper.CollectAuditMapper;
import com.recruit.mapper.ResumeVersionMapper;
import com.recruit.vo.ExtAttachmentContentVO;
import com.recruit.vo.ExtCollectResultVO;
import com.recruit.vo.ExtRulesVO;
import lombok.RequiredArgsConstructor;
import lombok.extern.log4j.Log4j2;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/**
 * 简历采集（框架 §2 Phase 1.1–1.4 的后端实现）。
 *
 * <p>三级幂等（框架 §1.3 / §4.2）：
 * <ol>
 *   <li>候选人：platform +（platformUserId **∪** platformUserIdAlt）—— 同一人有两种 ID 形态
 *       （BOSS 数字 uid / 加密 geekId），双键查才不分裂，见 {@link #idCandidatesOf}</li>
 *   <li>简历版本：candidateId + content_hash（归一字段 JSON 的 SHA-256，内容相同则跳过不产生新行）</li>
 *   <li>附件：platform + platformFileId（构造口径见 attachment 建表脚本头注释）</li>
 * </ol></p>
 *
 * <p>合规约束在服务端强制执行，不依赖扩展端自觉：
 * 缺少 consent 的请求直接拒绝；单次提交多于 1 条候选人直接拒绝
 * （列表页一次翻页会带回整页候选人，逐条确认是框架 §6 红线第 1 条）。</p>
 *
 * <p>审计与入库同事务：collect_audit 是 append-only 的自证材料，
 * 若入库回滚而审计留存，材料即失真，故必须原子。</p>
 */
@Log4j2
@RequiredArgsConstructor
@Service
public class CollectService {

    /** 附件单文件上限（防误传大文件；Phase 0 实测简历 PDF 在 130–220KB 量级） */
    private static final long MAX_ATTACHMENT_BYTES = 20L * 1024 * 1024;

    private final CandidateMapper candidateMapper;
    private final ResumeVersionMapper resumeVersionMapper;
    private final AttachmentMapper attachmentMapper;
    private final CollectAuditMapper collectAuditMapper;
    private final AttachmentStorageService attachmentStorageService;

    // ==================================================================
    // 规则下发（插件保持薄的关键，框架 §0 总原则第 3 条）
    // ==================================================================

    /** 动态下发采集规则；扩展端按 version 判断是否需要刷新 */
    public ExtRulesVO rules() {
        return ExtRulesVO.builder()
                .platform(CollectRules.PLATFORM_BOSS)
                .version(CollectRules.VERSION)
                .resumeKeys(CollectRules.RESUME_KEYS)
                .noisyKeys(CollectRules.NOISY_KEYS)
                .attachUrlPattern(CollectRules.ATTACH_URL_PATTERN)
                .attachContentTypePattern(CollectRules.ATTACH_CONTENT_TYPE_PATTERN)
                .noisePathPrefixes(CollectRules.NOISE_PATH_PREFIXES)
                .scenes(CollectRules.SCENES)
                .sourceChannels(CollectRules.SOURCE_CHANNELS)
                .note(CollectRules.NOTE)
                .build();
    }

    // ==================================================================
    // 提交采集
    // ==================================================================

    @Transactional(rollbackFor = Exception.class)
    public ExtCollectResultVO submit(ExtCollectSubmitDTO dto, Long extUserId, Long extTokenId) {
        requireConsent(dto);
        if (!CollectRules.PLATFORM_BOSS.equals(dto.getPlatform())) {
            throw new MyException(400, "一期仅支持 platform=" + CollectRules.PLATFORM_BOSS);
        }
        int size = dto.getCandidates().size();
        if (size > 1) {
            // 服务端强制逐条：不依赖扩展端自觉
            throw new MyException(400,
                    "一期不支持单次提交多条（收到 " + size + " 条）：列表页也必须逐条确认，禁止整页批量提交");
        }

        ExtCollectResultVO last = null;
        for (ExtCollectSubmitDTO.CandidatePayload payload : dto.getCandidates()) {
            last = collectOne(dto, payload, extUserId, extTokenId);
        }
        return last;
    }

    /** 单个候选人的入库：候选人幂等 → 版本去重 → 附件登记 → 审计 */
    private ExtCollectResultVO collectOne(ExtCollectSubmitDTO dto, ExtCollectSubmitDTO.CandidatePayload p,
                                          Long extUserId, Long extTokenId) {
        String platform = dto.getPlatform();
        LocalDateTime now = LocalDateTime.now(ZoneOffset.UTC);
        LocalDateTime collectedAt = p.getCollectedAt() != null ? p.getCollectedAt() : now;

        // ---------- 1) 候选人归一（双 ID 空间 → 同一行）----------
        // ★ 为什么不能只按 platform_user_id 单键查 ★
        //   BOSS 对同一个人会给出**两种** ID 形态：聊天消息给数字 uid（608120464）、
        //   候选人卡片给加密 geekId（01858de472ad39180XRy2t-9FFRU）。
        //   单键查的后果是「先采到数字、后采到加密」就分裂成两条候选人记录 ——
        //   2026-09-21 实测已中两次（陈诗健、谢建广）。
        //   归一规则（用户决策）：任一形态都落回同一行，新简历直接追加到该人的明细下。
        List<String> idCandidates = idCandidatesOf(p.getPlatformUserId(), p.getSecondaryPlatformUserId());
        // 刻意不加 LIMIT：多命中要能**数出来并报警**（见下方 log.warn），
        // 而重复行的数量级就是「这个人的 ID 形态数」，最多个位数，没有性能问题。
        // 取最早一行保证行为确定 —— 「同一请求重复执行落到同一行」比「挑一条看起来更全的」重要得多。
        List<Candidate> hits = candidateMapper.selectList(new LambdaQueryWrapper<Candidate>()
                .eq(Candidate::getPlatform, platform)
                .and(q -> q.in(Candidate::getPlatformUserId, idCandidates)
                        .or()
                        .in(Candidate::getPlatformUserIdAlt, idCandidates))
                .orderByAsc(Candidate::getId));

        String phoneHash = hashOrNull(p.getPhone());
        String emailHash = hashOrNull(p.getEmail());

        // 规范键：加密 ID 优先。附件下载端点的路径段就是加密 geekId，
        // 二者用同一标识对齐，核对附件归属时不必再做一次 ID 换算。
        String canonicalId = looksEncryptedId(p.getPlatformUserId())
                ? p.getPlatformUserId()
                : (looksEncryptedId(p.getSecondaryPlatformUserId())
                        ? p.getSecondaryPlatformUserId()
                        : p.getPlatformUserId());

        Candidate candidate = hits.isEmpty() ? null : hits.get(0);
        if (hits.size() > 1) {
            log.warn("候选人归一命中 {} 行（历史双 ID 残留）：platform={}, ids={}, 本次采用 id={}。"
                            + "请执行 sql/upgrade/candidate_normalize_dual_id_space_20260921_V1.sql 收敛存量",
                    hits.size(), platform, idCandidates, candidate.getId());
        }
        boolean candidateCreated = candidate == null;

        if (candidateCreated) {
            candidate = new Candidate();
            candidate.setPlatform(platform);
            candidate.setPlatformUserId(canonicalId);
            candidate.setPlatformUserIdAlt(altIdOf(canonicalId, idCandidates));
            candidate.setPhoneHash(phoneHash);
            candidate.setEmailHash(emailHash);
            candidate.setSourceChannel(nvl(p.getSourceChannel(), p.getScene()));
            candidate.setSourcePlatformUserRaw(nvl(p.getSecondaryPlatformUserId(), p.getPlatformUserId()));
            candidate.setMergedInto(findMergeTarget(platform, phoneHash, emailHash));
            candidate.setVersionCount(0);
            candidate.setFirstCollectedAt(collectedAt);
            candidate.setLastCollectedAt(collectedAt);
            applySummary(candidate, p.getFields());
            candidateMapper.insert(candidate);
            if (candidate.getMergedInto() != null) {
                writeAudit("merge", "ok", extUserId, extTokenId, platform, p.getPlatformUserId(),
                        candidate.getId(), p.getScene(), dto.getConsent().getPageUrl(), p.getSourceApi(),
                        "手机号/邮箱摘要命中已有候选人 " + candidate.getMergedInto() + "，已标记待人工确认归并");
            }
        } else {
            // 补空不覆盖：低质量采集不得污染已有更完整的字段
            applySummary(candidate, p.getFields());
            if (candidate.getPhoneHash() == null) {
                candidate.setPhoneHash(phoneHash);
            }
            if (candidate.getEmailHash() == null) {
                candidate.setEmailHash(emailHash);
            }
            // ★ 归一的关键一步：把这次学到的「另一种 ID 形态」记下来 ★
            //   没有它，下次只带加密 ID 来时（旧行是数字键、且双方无交集）会被当成新人建第二行。
            //   已有值不动（首次学到即长期形态），避免动唯一键引发的键冲突。
            if (!StringUtils.hasText(candidate.getPlatformUserIdAlt())) {
                String learned = altIdOf(candidate.getPlatformUserId(), idCandidates);
                if (learned != null) {
                    candidate.setPlatformUserIdAlt(learned);
                    log.info("候选人归一：为 id={} 补上另一种 ID 形态 {}", candidate.getId(), learned);
                }
            }
            candidate.setLastCollectedAt(collectedAt);
            candidateMapper.updateById(candidate);
        }

        // ---------- 2) 简历版本去重 ----------
        String fieldsJson = canonicalJson(p.getFields());
        String contentHash = sha256Hex(fieldsJson.getBytes(StandardCharsets.UTF_8));
        // 用 selectList + LIMIT 1，而不是 selectOne。
        // 表上其实**有**唯一键 uk_candidate_hash (candidate_id, content_hash)，
        // 所以「同 candidate 同 hash 两行」在正常情况下不可能出现，selectOne 也能跑。
        // 这里仍取列表形式，是为了**不把采集堵死**：一旦唯一键因某种原因缺失/被放宽
        // （或将来换成非唯一索引），selectOne 会因为 TooManyResults 让整个采集直接失败，
        // 而 LIMIT 1 只是安静地取第一条、行为仍然确定。属于零成本的防御，不是必需的绕行。
        List<ResumeVersion> sameContent = resumeVersionMapper.selectList(
                new LambdaQueryWrapper<ResumeVersion>()
                        .eq(ResumeVersion::getCandidateId, candidate.getId())
                        .eq(ResumeVersion::getContentHash, contentHash)
                        .orderByAsc(ResumeVersion::getId)
                        .last("LIMIT 1"));
        ResumeVersion version = sameContent.isEmpty() ? null : sameContent.get(0);
        boolean versionCreated = version == null;
        if (versionCreated) {
            version = new ResumeVersion();
            version.setCandidateId(candidate.getId());
            version.setPlatform(platform);
            version.setSource(nvl(p.getSource(), p.getScene()));
            version.setSourceApi(p.getSourceApi());
            version.setPlatformResumeId(p.getPlatformResumeId());
            version.setFieldsJson(fieldsJson);
            version.setFieldCount(p.getFields() == null ? 0 : p.getFields().size());
            version.setRawJson(p.getRaw());
            version.setRawEncrypted(flag(p.getRawEncrypted()));
            version.setRawBytes(p.getRawBytes() != null ? p.getRawBytes()
                    : (p.getRaw() == null ? null : p.getRaw().length()));
            version.setRawTruncated(flag(p.getRawTruncated()));
            version.setContentHash(contentHash);
            version.setSourceUrl(p.getSourceUrl());
            version.setCollectedAt(collectedAt);
            version.setOperatedBy(extUserId);
            resumeVersionMapper.insert(version);

            candidate.setVersionCount(Math.toIntExact(resumeVersionMapper.selectCount(
                    new LambdaQueryWrapper<ResumeVersion>().eq(ResumeVersion::getCandidateId, candidate.getId()))));
            candidateMapper.updateById(candidate);
        }

        // ---------- 3) 附件登记（只登记元数据，字节由扩展端重放下载后回传） ----------
        List<Long> needUpload = new ArrayList<>();
        if (p.getAttachments() != null) {
            for (ExtCollectSubmitDTO.AttachmentPayload ap : p.getAttachments()) {
                Attachment attachment = attachmentMapper.selectOne(new LambdaQueryWrapper<Attachment>()
                        .eq(Attachment::getPlatform, platform)
                        .eq(Attachment::getPlatformFileId, ap.getPlatformFileId()));
                if (attachment == null) {
                    attachment = new Attachment();
                    attachment.setCandidateId(candidate.getId());
                    attachment.setResumeVersionId(version.getId());
                    attachment.setPlatform(platform);
                    attachment.setPlatformFileId(ap.getPlatformFileId());
                    attachment.setFileName(ap.getFileName());
                    attachment.setContentType(ap.getContentType());
                    attachment.setBytes(ap.getBytes());
                    attachment.setOriginUrl(ap.getOriginUrl());
                    attachment.setOriginTicketExpiresAt(ap.getTicketExpiresAt());
                    attachment.setStatus("pending");
                    attachment.setSourceScene(nvl(ap.getSourceScene(), p.getScene()));
                    attachment.setCollectedAt(collectedAt);
                    attachment.setOperatedBy(extUserId);
                    attachmentMapper.insert(attachment);
                } else if (attachment.getResumeVersionId() == null) {
                    attachment.setResumeVersionId(version.getId());
                    attachmentMapper.updateById(attachment);
                }
                if (!"stored".equals(attachment.getStatus())) {
                    needUpload.add(attachment.getId());
                }
            }
        }

        // ---------- 4) 审计（consent + collect 两条，同事务） ----------
        writeAudit("consent", "ok", extUserId, extTokenId, platform, p.getPlatformUserId(),
                candidate.getId(), dto.getConsent().getScene(), dto.getConsent().getPageUrl(), null,
                "HR 已确认本次采集仅用于本单位招聘");
        String auditId = writeAudit("collect", "ok", extUserId, extTokenId, platform, p.getPlatformUserId(),
                candidate.getId(), p.getScene(), dto.getConsent().getPageUrl(), p.getSourceApi(),
                buildCollectNote(candidateCreated, versionCreated, needUpload.size()));

        log.info("采集入库：platform={}, geek={}, candidate={}({}), version={}({}), 待上传附件={}, operator={}",
                platform, p.getPlatformUserId(), candidate.getId(), candidateCreated ? "新建" : "复用",
                version.getId(), versionCreated ? "新建" : "去重", needUpload.size(), extUserId);

        return ExtCollectResultVO.builder()
                .candidateId(String.valueOf(candidate.getId()))
                .candidateCreated(candidateCreated)
                .resumeVersionId(String.valueOf(version.getId()))
                .resumeVersionCreated(versionCreated)
                .attachmentIds(needUpload.stream().map(String::valueOf).toList())
                .auditId(auditId)
                .message(buildCollectNote(candidateCreated, versionCreated, needUpload.size()))
                .build();
    }

    // ==================================================================
    // 审计上报（确认后未提交 / 失败场景）
    // ==================================================================

    @Transactional(rollbackFor = Exception.class)
    public String reportAudit(ExtAuditDTO dto, Long extUserId, Long extTokenId) {
        String result = StringUtils.hasText(dto.getResult()) ? dto.getResult() : "ok";
        return writeAudit(dto.getAction(), result, extUserId, extTokenId, dto.getPlatform(),
                dto.getPlatformUserId(), null, dto.getScene(), dto.getPageUrl(), dto.getSourceApi(),
                dto.getNote(), dto.getOccurredAt());
    }

    // ==================================================================
    // 附件字节上传（扩展端 SW 重放下载成功后回传）
    // ==================================================================

    @Transactional(rollbackFor = Exception.class)
    public ExtAttachmentContentVO saveAttachmentContent(Long attachmentId, MultipartFile file,
                                                        String declaredSha256,
                                                        Long extUserId, Long extTokenId) {
        Attachment attachment = attachmentMapper.selectById(attachmentId);
        if (attachment == null) {
            throw new MyException(404, "附件不存在");
        }
        // 幂等：已落盘直接返回，重复上传不报错（扩展端重试友好）
        if ("stored".equals(attachment.getStatus()) && attachment.getStorageKey() != null) {
            return buildContentVO(attachment, "附件已落盘，本次上传被幂等跳过");
        }
        if (file == null || file.isEmpty()) {
            throw new MyException(400, "上传内容为空");
        }
        byte[] bytes;
        try {
            bytes = file.getBytes();
        } catch (IOException e) {
            throw new MyException(500, "读取上传内容失败: " + e.getMessage());
        }
        if (bytes.length > MAX_ATTACHMENT_BYTES) {
            throw new MyException(400, "附件超过 " + (MAX_ATTACHMENT_BYTES / 1024 / 1024) + "MB 上限");
        }

        String fileName = StringUtils.hasText(file.getOriginalFilename())
                ? file.getOriginalFilename()
                : attachment.getFileName();
        String storageKey = attachmentStorageService.buildKey(
                attachment.getPlatform(), attachment.getPlatformFileId(), fileName);
        AttachmentStorageService.Stored stored = attachmentStorageService.store(storageKey, bytes);

        LocalDateTime now = LocalDateTime.now(ZoneOffset.UTC);
        attachment.setStatus("stored");
        attachment.setBytes(stored.bytes());
        attachment.setSha256(stored.sha256());
        attachment.setStorageKey(stored.storageKey());
        attachment.setStoredAt(now);
        attachment.setFailReason(null);
        if (!StringUtils.hasText(attachment.getFileName())) {
            attachment.setFileName(fileName);
        }
        if (!StringUtils.hasText(attachment.getContentType()) && file.getContentType() != null) {
            attachment.setContentType(file.getContentType());
        }
        attachmentMapper.updateById(attachment);

        String note = "落盘 " + stored.bytes() + " 字节，sha256=" + stored.sha256();
        if (StringUtils.hasText(declaredSha256) && !declaredSha256.equalsIgnoreCase(stored.sha256())) {
            // 客户端声明与服务端实算不一致：以服务端为准，但必须留痕
            note += "（客户端声明 " + declaredSha256 + "，不一致，以服务端实算为准）";
            log.warn("附件摘要不一致：id={}, 客户端={}, 服务端={}",
                    attachmentId, declaredSha256, stored.sha256());
        }
        writeAudit("attach_download", "ok", extUserId, extTokenId, attachment.getPlatform(),
                null, attachment.getCandidateId(), attachment.getSourceScene(),
                null, attachment.getOriginUrl(), note);
        log.info("附件落盘：id={}, key={}, bytes={}", attachmentId, stored.storageKey(), stored.bytes());

        return buildContentVO(attachment, "附件已落盘");
    }

    /** 附件下载失败回报（保留失败原因 —— 这是 Phase 0 V4 命题的证据） */
    @Transactional(rollbackFor = Exception.class)
    public void markAttachmentFailed(Long attachmentId, String reason, Long extUserId, Long extTokenId) {
        Attachment attachment = attachmentMapper.selectById(attachmentId);
        if (attachment == null) {
            throw new MyException(404, "附件不存在");
        }
        if ("stored".equals(attachment.getStatus())) {
            // 已落盘的不允许被失败回报覆盖
            return;
        }
        attachment.setStatus("failed");
        attachment.setFailReason(cut(reason, 512));
        attachmentMapper.updateById(attachment);
        writeAudit("attach_download", "failed", extUserId, extTokenId, attachment.getPlatform(),
                null, attachment.getCandidateId(), attachment.getSourceScene(),
                null, attachment.getOriginUrl(), cut(reason, 512));
        log.warn("附件下载失败：id={}, reason={}", attachmentId, reason);
    }

    // ==================================================================
    // 内部工具
    // ==================================================================

    private void requireConsent(ExtCollectSubmitDTO dto) {
        if (dto.getConsent() == null || !Boolean.TRUE.equals(dto.getConsent().getConfirmed())) {
            throw new MyException(400,
                    "缺少采集前确认：服务端只接受 HR 主动点击采集的请求（框架 §6 红线第 1 条：只做主动触发采集）");
        }
    }

    /**
     * 跨平台归并：手机号/邮箱摘要命中**其他平台**的候选人时，标记待人工确认的归并目标。
     *
     * <p>刻意不自动合并：框架 §4.3 明确要评估误合并风险，自动化归并一旦误判，
     * 会把两个不同的人的简历版本混在一起，代价远高于让人确认一次。</p>
     */
    private Long findMergeTarget(String platform, String phoneHash, String emailHash) {
        if (phoneHash == null && emailHash == null) {
            return null;
        }
        LambdaQueryWrapper<Candidate> wrapper = new LambdaQueryWrapper<Candidate>()
                .ne(Candidate::getPlatform, platform)
                .isNull(Candidate::getMergedInto)
                .and(w -> {
                    if (phoneHash != null) {
                        w.eq(Candidate::getPhoneHash, phoneHash);
                    }
                    if (emailHash != null) {
                        if (phoneHash != null) {
                            w.or();
                        }
                        w.eq(Candidate::getEmailHash, emailHash);
                    }
                })
                .orderByAsc(Candidate::getId)
                .last("LIMIT 1");
        Candidate hit = candidateMapper.selectOne(wrapper);
        return hit == null ? null : hit.getId();
    }

    /**
     * 归一用的 ID 候选集：规范键 + 备用键，去空去重。
     *
     * <p>这两个值由扩展从**同一个候选人对象**上取，所以必然是同一个人的两种形态
     * （扩展侧见 background.js：备用键取自 sel.secondary / 跨 ID 空间映射表）。
     * 这一点是整个归一的正确性前提 —— 备用键一旦混入别人的 ID，
     * 就会把另一个人的采集请求吸到这条记录上（候选人级别的张冠李戴）。</p>
     */
    private List<String> idCandidatesOf(String primary, String secondary) {
        List<String> out = new ArrayList<>(2);
        for (String v : new String[]{primary, secondary}) {
            if (StringUtils.hasText(v) && !out.contains(v)) {
                out.add(v);
            }
        }
        return out;
    }

    /**
     * 备用键：候选集中第一个与规范键不同的值。
     *
     * <p>两边都没有、或只有一种形态时返回 null（不写空串 —— 查询侧靠 NULL 判断「尚未学到」）。</p>
     */
    private String altIdOf(String canonicalId, List<String> idCandidates) {
        for (String v : idCandidates) {
            if (!v.equals(canonicalId)) {
                return v;
            }
        }
        return null;
    }

    /** 加密 ID 形态：字母数字混排 16–64 位（与扩展端 background.js 的 looksEncryptedId 同口径） */
    private boolean looksEncryptedId(String v) {
        if (!StringUtils.hasText(v) || v.length() < 16 || v.length() > 64) {
            return false;
        }
        boolean digit = false;
        boolean alpha = false;
        for (int i = 0; i < v.length(); i += 1) {
            char c = v.charAt(i);
            if (c >= '0' && c <= '9') {
                digit = true;
            } else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
                alpha = true;
            } else if (c != '_' && c != '~' && c != '-') {
                return false;
            }
        }
        return digit && alpha;
    }

    /**
     * 把平台原始字段映射到候选人摘要列。
     * 只补空值，不覆盖已有值 —— 同一个人的多次采集中，后一次可能是更简略的列表卡片。
     */
    private void applySummary(Candidate c, Map<String, Object> f) {
        if (f == null || f.isEmpty()) {
            return;
        }
        setIfBlank(c.getName(), v -> c.setName(v), pick(f, "name", "geekName", "user.name"));
        setIfBlank(c.getCurrentTitle(), v -> c.setCurrentTitle(v),
                pick(f, "positionName", "currentTitle", "position", "positionCategory"));
        setIfBlank(c.getExpectSalary(), v -> c.setExpectSalary(v),
                pick(f, "expectSalary", "salaryDesc", "salary", "jobSalary"));
        setIfBlank(c.getCity(), v -> c.setCity(v), pick(f, "city"));
        setIfBlank(c.getEducation(), v -> c.setEducation(v), pick(f, "education", "edu", "degree"));
        setIfBlank(c.getSchool(), v -> c.setSchool(v), pick(f, "school"));
        setIfBlank(c.getMajor(), v -> c.setMajor(v), pick(f, "major"));
        setIfBlank(c.getWorkYear(), v -> c.setWorkYear(v), pick(f, "workYear", "year"));
        setIfBlank(c.getAge(), v -> c.setAge(v), pick(f, "ageDesc", "age"));
        if (c.getGender() == null) {
            Integer g = toInt(pick(f, "gender", "geekGender"));
            if (g != null) {
                c.setGender(g);
            }
        }
    }

    private void setIfBlank(String current, java.util.function.Consumer<String> setter, String value) {
        if (!StringUtils.hasText(current) && StringUtils.hasText(value)) {
            setter.accept(cut(value, 128));
        }
    }

    /**
     * 按优先级取第一个非空字段（平台同一语义有多个命名，见 CollectRules 头注释）。
     * 键支持点号路径，例如 {@code user.name}。
     */
    private String pick(Map<String, Object> f, String... keys) {
        for (String k : keys) {
            Object v = resolvePath(f, k);
            if (v instanceof String s && StringUtils.hasText(s)) {
                return s.trim();
            }
            if (v instanceof Number || v instanceof Boolean) {
                return String.valueOf(v);
            }
        }
        return null;
    }

    /**
     * 支持 {@code "user.name"} 这类点号路径。
     *
     * <p>为什么需要：真机实测 —— 聊天消息（historyMsg）里的简历对象是
     * {@code messages[].body.resume}，姓名在 {@code body.resume.user.name}（嵌了一层），
     * 而 {@code body.resume} 顶层并没有 name。只扫顶层会让姓名落成 NULL
     * （这条是 2026-09-21 真机采集时发现的）。</p>
     */
    private Object resolvePath(Map<String, Object> f, String path) {
        if (f == null || path == null) {
            return null;
        }
        if (path.indexOf('.') < 0) {
            return f.get(path);
        }
        Object cur = f;
        for (String seg : path.split("\\.")) {
            if (!(cur instanceof Map)) {
                return null;
            }
            cur = ((Map<?, ?>) cur).get(seg);
        }
        return cur;
    }

    private Integer toInt(String s) {
        if (!StringUtils.hasText(s)) {
            return null;
        }
        try {
            return Integer.valueOf(s.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /**
     * 归一字段的规范化 JSON：按字段名排序，保证同一份数据两次采集得到同一个 content_hash。
     * 不排序的话 Map 迭代顺序差异会让去重失效，重复点采集就产生重复版本。
     */
    private String canonicalJson(Map<String, Object> fields) {
        if (fields == null || fields.isEmpty()) {
            return "{}";
        }
        return JSON.toJSONString(fields, JSONWriter.Feature.MapSortField);
    }

    private String buildCollectNote(boolean candidateCreated, boolean versionCreated, int needUpload) {
        StringBuilder sb = new StringBuilder();
        sb.append(candidateCreated ? "新建候选人" : "复用已有候选人");
        sb.append("；").append(versionCreated ? "新建简历版本" : "内容相同，版本去重跳过");
        if (needUpload > 0) {
            sb.append("；待下载附件 ").append(needUpload).append(" 个");
        }
        return sb.toString();
    }

    private ExtAttachmentContentVO buildContentVO(Attachment a, String message) {
        return ExtAttachmentContentVO.builder()
                .attachmentId(String.valueOf(a.getId()))
                .status(a.getStatus())
                .bytes(a.getBytes())
                .sha256(a.getSha256())
                .fileName(a.getFileName())
                .storageKey(a.getStorageKey())
                .message(message)
                .build();
    }

    /** 写审计（append-only，永不 UPDATE/DELETE） */
    private String writeAudit(String action, String result, Long extUserId, Long extTokenId,
                              String platform, String platformUserId, Long candidateId,
                              String scene, String pageUrl, String sourceApi, String note) {
        return writeAudit(action, result, extUserId, extTokenId, platform, platformUserId,
                candidateId, scene, pageUrl, sourceApi, note, null);
    }

    private String writeAudit(String action, String result, Long extUserId, Long extTokenId,
                              String platform, String platformUserId, Long candidateId,
                              String scene, String pageUrl, String sourceApi, String note,
                              LocalDateTime occurredAt) {
        CollectAudit audit = new CollectAudit();
        audit.setAction(action);
        audit.setResult(result);
        audit.setOperatorId(extUserId);
        audit.setExtTokenId(extTokenId);
        audit.setPlatform(platform);
        audit.setPlatformUserId(platformUserId);
        audit.setCandidateId(candidateId);
        audit.setScene(scene);
        audit.setPageUrl(cut(pageUrl, 1024));
        audit.setSourceApi(cut(sourceApi, 255));
        audit.setClientNote(cut(note, 512));
        audit.setOccurredAt(occurredAt != null ? occurredAt : LocalDateTime.now(ZoneOffset.UTC));
        collectAuditMapper.insert(audit);
        return String.valueOf(audit.getId());
    }

    private String hashOrNull(String raw) {
        if (!StringUtils.hasText(raw)) {
            return null;
        }
        // 红线：手机号/邮箱原文只在此处短暂存在于内存，既不持久化也不写日志
        return sha256Hex(raw.trim().getBytes(StandardCharsets.UTF_8));
    }

    private String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception e) {
            throw new MyException(500, "计算摘要失败: " + e.getMessage());
        }
    }

    private int flag(Integer v) {
        return v != null && v == 1 ? 1 : 0;
    }

    private String nvl(String a, String b) {
        return StringUtils.hasText(a) ? a : b;
    }

    private String cut(String s, int max) {
        if (s == null) {
            return null;
        }
        return s.length() <= max ? s : s.substring(0, max);
    }
}
