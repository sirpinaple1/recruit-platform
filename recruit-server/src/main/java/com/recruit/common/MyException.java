package com.recruit.common;

import lombok.Getter;

/**
 * 业务异常：code 会原样透传到 R.code（业务侧建议用 4xx）
 */
@Getter
public class MyException extends RuntimeException {

    private final int code;

    public MyException(String msg) {
        this(400, msg);
    }

    public MyException(int code, String msg) {
        super(msg);
        this.code = code;
    }
}
