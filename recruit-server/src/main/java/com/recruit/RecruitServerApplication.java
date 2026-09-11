package com.recruit;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * recruit-server 启动类。
 */
@SpringBootApplication
@MapperScan("com.recruit.mapper")
public class RecruitServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(RecruitServerApplication.class, args);
    }
}
