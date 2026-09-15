SET NAMES utf8mb4;
-- ====================================
-- T3.1 mock_demo 渠道种子数据
-- 依据：docs/design/channel-publish.md §5.2 / §8
-- 配合 T4 fixtures/publish-mock.html 本地模拟发布页使用
-- ====================================

INSERT INTO channel (id, code, name, publish_url_pattern, field_map_json, deep_link_template, capability, status, sort_order, remark)
VALUES (
    1,
    'mock_demo',
    '演示渠道（本地Mock）',
    'file://*publish-mock.html',
    '{"fields":[{"key":"title","match":["职位名称","岗位名称","jobTitle"],"type":"input"},{"key":"jobDescription","match":["职位描述","岗位职责","jobDesc"],"type":"textarea"},{"key":"location","match":["工作地点","工作城市"],"type":"input"},{"key":"salaryText","match":["薪资范围","月薪"],"type":"input"},{"key":"education","match":["学历要求","学历"],"type":"select"}],"selectors":{"title":"#job-title-input"}}',
    'https://apply.example.com/jobs/{requestNo}',
    'manual',
    'enabled',
    0,
    '本地 fixtures 发布页联调用演示渠道'
);
