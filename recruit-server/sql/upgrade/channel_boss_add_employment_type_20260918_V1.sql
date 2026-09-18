SET NAMES utf8mb4;
-- ====================================
-- BOSS 渠道配置更新：职位类型字段改为平台推荐选择（2026-09-18 二次修订）
--
-- 背景：第一版此脚本给 field_map_json 添加了 employmentType(auto-suggest)，
--      实测发现两条问题，本版整体覆盖修正：
--   1. BOSS 的「职位类型」是职类（jobCategory），不是雇佣类型（全职/兼职）；
--      match 含「类型」还会误匹配到职位类型输入框，把「全职」写进去污染推荐流程。
--   2. BOSS 的职类选择依赖「职位描述失焦」触发的预测接口，正确做法是
--      type=recommend：引擎先触发 JD 失焦预测，再点开输入框选平台推荐项
--      （实测推荐项按相关度排序，无需配置值，用 BOSS 自己的预测）。
--
-- 变更内容：整字段覆盖 field_map_json ——
--   · 移除 employmentType 字段（hr_request 的雇佣类型无对应平台控件）
--   · 新增 jobCategory 字段（type: recommend, match: ["职位类型"]）
--   · 其余字段（title/jobDescription/experienceYears/education/
--     salaryMin(nth:0)/salaryMax(nth:1) 及 valueMap/_unit）保持不变
--
-- 注意：配合后端 PublishDraftService.applyValueMap（同日新增）使用——
--      渲染草稿时应用 valueMap/_unit（元转 k），否则引擎拿到原始值必然填充失败。
--
-- 幂等：整字段覆盖，重复执行结果一致。
-- ====================================

UPDATE channel
SET field_map_json = '{"fields": [{"key": "title", "type": "input", "match": ["职位名称"]}, {"key": "jobDescription", "type": "textarea", "match": ["职位描述", "请勿填写QQ"]}, {"key": "experienceYears", "type": "dropdown", "match": ["经验"], "valueMap": {"1": "1-3年", "2": "1-3年", "3": "3-5年", "4": "3-5年", "5": "5-10年", "6": "5-10年", "7": "5-10年", "8": "5-10年", "9": "5-10年", "10": "10年以上"}}, {"key": "education", "type": "dropdown", "match": ["学历"], "valueMap": {"doctor": "博士", "master": "硕士", "博士": "博士", "大专": "大专", "本科": "本科", "硕士": "硕士", "高中": "高中", "bachelor": "本科", "associate": "大专", "high_school": "高中"}}, {"key": "salaryMin", "nth": 0, "type": "dropdown", "match": ["薪资范围", "最低月薪"], "valueMap": {"_unit": "yuanToK"}}, {"key": "salaryMax", "nth": 1, "type": "dropdown", "match": ["薪资范围", "最高月薪"], "valueMap": {"_unit": "yuanToK"}}, {"key": "jobCategory", "type": "recommend", "match": ["职位类型"]}]}'
WHERE code = 'boss';
