SET NAMES utf8mb4;
-- ====================================
-- BOSS 直聘渠道种子数据（本轮无感化改造的目标渠道）
-- 依据：docs/design/channel-publish-seamless.md §7 / §10
--
-- 为什么补这个文件：BOSS 渠道此前**只存在于本地库**（E2E 联调时手工建的），
--      没有任何 seed 文件。后果是全新库拿不到该渠道 → 本轮验收（BOSS 单渠道跑通）
--      在新环境无法复现。此文件把本地库的真实配置固化为真源。
--
-- field_map_json 的来源：从本地库**只读导出**，非重新设计。
--      其中 valueMap / nth / _unit 三项是实际联调时手工调好的，务必原样保留：
--        · nth: 0 / 1 —— 薪资范围一行里有两个下拉（最低/最高月薪），靠 nth 区分
--        · valueMap    —— 平台选项文本 ≠ 系统取值（如 education 的 bachelor → 本科）
--        · _unit: yuanToK —— hr_request.salary_min 存「元」，平台要「K」
--      简化或"整理"这些配置会让填充直接失效。
--
-- ⚠️ publish_entry_url 待确认（**必须人工核对后再用于生产**）：
--      本文件填的值是从本地库 publish_url_pattern 抄来的，属**权宜值**。
--      该 URL 带易变 query 参数（jobversion=11363 / encryptId=0 / enterSource=2），
--      其中 encryptId 看起来是会话相关参数，直接导航未必能落到可用的发布表单。
--      上线前需人工在浏览器里确认 BOSS 的真实发布页入口（登录后进入「发布职位」
--      页面，复制地址栏 URL），再更新本文件与库数据。
--
-- ⚠️ publish_url_pattern 当前与 entry 同值（无通配），这是**迁移中间态**：
--      该列语义应为「注入校验模式」（如 https://www.zhipin.com/*），
--      而非导航入口。等 extension/background.js 的通配处理修好后，
--      应把 pattern 改为通配、entry 保留具体地址。现在先不动，
--      避免在扩展未就绪时改变现有可用行为。
--
-- 幂等：INSERT IGNORE 依赖 channel.uk_code(code)；可重复执行。
--      id 用本地库的雪花 ID，使新库与存量库取值一致（便于跨环境核对）。
-- ====================================

INSERT IGNORE INTO channel (id, code, name, publish_url_pattern, publish_entry_url, field_map_json, deep_link_template, capability, status, sort_order, remark)
VALUES (
    2099758705647771650,
    'boss',
    'BOSS直聘',
    'https://www.zhipin.com/web/frame/job/publish-edit?jobversion=11363&encryptId=0&enterSource=2',
    'https://www.zhipin.com/web/frame/job/publish-edit?jobversion=11363&encryptId=0&enterSource=2',
    '{"fields": [{"key": "title", "type": "input", "match": ["职位名称"]}, {"key": "jobDescription", "type": "textarea", "match": ["职位描述", "请勿填写QQ"]}, {"key": "experienceYears", "type": "dropdown", "match": ["经验"], "valueMap": {"1": "1-3年", "2": "1-3年", "3": "3-5年", "4": "3-5年", "5": "5-10年", "6": "5-10年", "7": "5-10年", "8": "5-10年", "9": "5-10年", "10": "10年以上"}}, {"key": "education", "type": "dropdown", "match": ["学历"], "valueMap": {"doctor": "博士", "master": "硕士", "博士": "博士", "大专": "大专", "本科": "本科", "硕士": "硕士", "高中": "高中", "bachelor": "本科", "associate": "大专", "high_school": "高中"}}, {"key": "salaryMin", "nth": 0, "type": "dropdown", "match": ["薪资范围", "最低月薪"], "valueMap": {"_unit": "yuanToK"}}, {"key": "salaryMax", "nth": 1, "type": "dropdown", "match": ["薪资范围", "最高月薪"], "valueMap": {"_unit": "yuanToK"}}]}',
    'https://apply.example.com/jobs/{requestNo}',
    'manual',
    'enabled',
    1,
    '真实平台（进阶验收用）'
);
