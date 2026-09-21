package com.recruit.controller;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.recruit.common.R;
import com.recruit.service.CandidateQueryService;
import com.recruit.vo.CandidateDetailVO;
import com.recruit.vo.CandidateVO;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;

/**
 * 候选人库查询（登录态，与渠道发布模块同鉴权口径）。
 *
 * <p>写入走 {@link ExtCollectController}（扩展 token），查询走登录态 —— 读写分离在鉴权层就分开，
 * 避免出现「扩展 token 能查全量候选人库」这种权限外溢。</p>
 */
@RequiredArgsConstructor
@RestController
@RequestMapping("/api/candidates")
public class CandidateController {

    private final CandidateQueryService candidateQueryService;

    /** 候选人分页（platform / keyword / sourceChannel 筛选；默认不含已归并行） */
    @GetMapping
    public R<IPage<CandidateVO>> page(@RequestParam(defaultValue = "1") long page,
                                      @RequestParam(defaultValue = "10") long size,
                                      @RequestParam(required = false) String platform,
                                      @RequestParam(required = false) String keyword,
                                      @RequestParam(required = false) String sourceChannel) {
        return R.ok(candidateQueryService.page(page, size, platform, keyword, sourceChannel));
    }

    /** 候选人详情：简历版本 + 附件 + 采集审计 */
    @GetMapping("/{id}")
    public R<CandidateDetailVO> detail(@PathVariable Long id) {
        return R.ok(candidateQueryService.detail(id));
    }

    /**
     * 附件正文：中台内联预览 / 下载（不走 {@code R<T>} 包装，直接吐字节）。
     *
     * <p>鉴权同候选人详情：本端点落在 {@code /api/**} 下，由 AuthInterceptor 校验
     * {@code Authorization: Bearer <jwt>}。这也是前端必须用带 header 的请求取二进制、
     * 不能把 URL 直接塞进 {@code <a href>} 或 {@code <img>} 的原因 —— 裸链接没有 header。</p>
     *
     * <ul>
     *   <li>{@code Content-Disposition: inline} —— 让浏览器就地渲染 PDF，而不是下载。</li>
     *   <li>{@code X-Content-Type-Options: nosniff} —— 我们主动声明了类型，禁止浏览器再嗅探；
     *       否则一份内容里带 HTML 的 PDF 有被当成页面执行的风险。</li>
     *   <li>{@code no-store} —— 简历属个人信息，不留在任何中间缓存里。</li>
     * </ul>
     */
    @GetMapping("/attachments/{attachmentId}/content")
    public ResponseEntity<byte[]> attachmentContent(@PathVariable Long attachmentId) {
        CandidateQueryService.AttachmentContent c = candidateQueryService.attachmentContent(attachmentId);
        ContentDisposition disposition = ContentDisposition.inline()
                .filename(c.fileName(), StandardCharsets.UTF_8)
                .build();
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, c.contentType())
                .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString())
                .header("X-Content-Type-Options", "nosniff")
                .cacheControl(CacheControl.noStore())
                .contentLength(c.bytes().length)
                .body(c.bytes());
    }
}
