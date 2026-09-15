package com.recruit.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 渠道注册表：新增渠道 = 插一行数据，不改任何代码（见设计文档 §5.2）
 */
@Data
@TableName("channel")
public class Channel {

    @TableId(type = IdType.ASSIGN_ID)
    private Long id;

    /** 渠道代码：boss/liepin/zhilian/mock_demo…（创建后不可改） */
    private String code;

    /** 渠道名称 */
    private String name;

    /** 发布页 URL 匹配模式（扩展注入判定） */
    private String publishUrlPattern;

    /** 字段映射配置 JSON（平台改版改数据不改扩展） */
    private String fieldMapJson;

    /** 投递深链模板（{requestNo} 占位） */
    private String deepLinkTemplate;

    /** manual/api/connector/rpa（本期只实装 manual） */
    private String capability;

    /** enabled/disabled */
    private String status;

    /** 排序 */
    private Integer sortOrder;

    /** 备注 */
    private String remark;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
