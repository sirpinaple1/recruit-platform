package com.recruit.common;

import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.stream.Collectors;

/**
 * 全局异常处理：所有异常统一转 R 返回
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    /** 业务异常：code 与提示原样透传 */
    @ExceptionHandler(MyException.class)
    public R<Void> handleMyException(MyException e) {
        log.info("业务异常: code={}, msg={}", e.getCode(), e.getMessage());
        return R.fail(e.getCode(), e.getMessage());
    }

    /** 参数校验失败：聚合全部字段的校验提示 */
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public R<Void> handleValidException(MethodArgumentNotValidException e) {
        String msg = e.getBindingResult().getFieldErrors().stream()
                .map(err -> err.getField() + " " + err.getDefaultMessage())
                .collect(Collectors.joining("; "));
        return R.fail(400, msg);
    }

    /** 兜底：未知异常记 error 日志，不向前端泄露细节 */
    @ExceptionHandler(Exception.class)
    public R<Void> handleException(Exception e) {
        log.error("未捕获异常", e);
        return R.fail(500, "系统繁忙，请稍后重试");
    }
}
