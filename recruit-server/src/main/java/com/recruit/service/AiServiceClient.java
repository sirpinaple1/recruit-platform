package com.recruit.service;

import com.recruit.common.MyException;
import com.recruit.dto.AiJdRequestDTO;
import com.recruit.dto.AiScoreRequestDTO;
import com.recruit.vo.AiJdResultVO;
import com.recruit.vo.AiScoreResultVO;
import lombok.extern.log4j.Log4j2;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import java.time.Duration;

/**
 * recruit-ai-service（Python/FastAPI）的 HTTP 客户端。
 *
 * <p>对接契约见 docs/conventions/java-python-integration.md §1.1 同步调用。
 * LLM 打分一次几秒到几十秒，读超时给足 60s；本客户端<b>只</b>被异步线程调用
 * （resumeScoreExecutor），不会占采集请求线程。</p>
 */
@Log4j2
@Service
public class AiServiceClient {

    private final RestClient restClient;

    public AiServiceClient(@Value("${ai.service.url}") String aiServiceUrl) {
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory();
        // 连接 5s（服务同机/局域网），读 60s（LLM 生成耗时）
        factory.setReadTimeout(Duration.ofSeconds(60));
        this.restClient = RestClient.builder()
                .baseUrl(aiServiceUrl)
                .requestFactory(factory)
                .build();
    }

    /**
     * 同步打分。
     *
     * @throws MyException AI 服务不可达 / 上游非 200 / 响应结构异常
     */
    public AiScoreResultVO.DataBody score(AiScoreRequestDTO request) {
        AiScoreResultVO resp;
        try {
            resp = restClient.post()
                    .uri("/api/v1/resume/score")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(request)
                    .retrieve()
                    .body(AiScoreResultVO.class);
        } catch (Exception e) {
            log.error("AI 服务调用失败: resumeId={}", request.getResumeId(), e);
            throw new MyException(502, "AI 服务调用失败: " + rootMessage(e));
        }
        if (resp == null || resp.getData() == null) {
            throw new MyException(502, "AI 服务响应结构异常: " + (resp == null ? "空响应" : resp.getMessage()));
        }
        if (resp.getCode() == null || resp.getCode() != 200) {
            throw new MyException(502, "AI 服务返回错误: " + resp.getMessage());
        }
        return resp.getData();
    }

    /**
     * 同步生成 JD（需求单表单「一键生成」用，用户在表单里等结果，走请求线程）。
     *
     * @throws MyException AI 服务不可达 / 上游非 200 / 响应结构异常
     */
    public AiJdResultVO.DataBody generateJd(AiJdRequestDTO request) {
        AiJdResultVO resp;
        try {
            resp = restClient.post()
                    .uri("/api/v1/jd/generate")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(request)
                    .retrieve()
                    .body(AiJdResultVO.class);
        } catch (Exception e) {
            log.error("AI 服务调用失败: jd, title={}", request.getTitle(), e);
            throw new MyException(502, "AI 服务调用失败: " + rootMessage(e));
        }
        if (resp == null || resp.getData() == null) {
            throw new MyException(502, "AI 服务响应结构异常: " + (resp == null ? "空响应" : resp.getMessage()));
        }
        if (resp.getCode() == null || resp.getCode() != 200) {
            throw new MyException(502, "AI 服务返回错误: " + resp.getMessage());
        }
        return resp.getData();
    }

    private String rootMessage(Throwable e) {
        Throwable cur = e;
        while (cur.getCause() != null && cur.getCause() != cur) {
            cur = cur.getCause();
        }
        String msg = cur.getMessage();
        return msg != null ? msg : cur.getClass().getSimpleName();
    }
}
