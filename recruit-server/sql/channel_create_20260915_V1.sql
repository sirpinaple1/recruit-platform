SET NAMES utf8mb4;
-- ====================================
-- T3.1 channel 渠道注册表建表
-- 依据：docs/design/channel-publish.md §5.2
-- 验收：新增一个渠道 = 插一行数据，不改任何代码
-- ====================================

CREATE TABLE IF NOT EXISTS channel (
    id BIGINT UNSIGNED PRIMARY KEY COMMENT '渠道ID（雪花ID）',
    code VARCHAR(32) NOT NULL COMMENT '渠道代码：boss/liepin/zhilian/mock_demo…',
    name VARCHAR(64) NOT NULL COMMENT '渠道名称',
    publish_url_pattern VARCHAR(512) COMMENT '发布页URL匹配模式（扩展注入判定，如 https://www.zhipin.com/*publish*）',
    field_map_json JSON NOT NULL COMMENT '字段映射配置（平台改版改数据不改扩展）',
    deep_link_template VARCHAR(512) COMMENT '投递深链模板（{requestNo} 占位；门户建成前指向占位页）',
    capability VARCHAR(16) NOT NULL DEFAULT 'manual' COMMENT '能力等级：manual/api/connector/rpa（本期只实装manual）',
    status VARCHAR(16) NOT NULL DEFAULT 'enabled' COMMENT '状态：enabled/disabled',
    sort_order INT NOT NULL DEFAULT 0 COMMENT '排序',
    remark VARCHAR(256) COMMENT '备注',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
    UNIQUE KEY uk_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='渠道注册表';
