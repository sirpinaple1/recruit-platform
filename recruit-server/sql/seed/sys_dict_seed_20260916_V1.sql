SET NAMES utf8mb4;
-- ====================================
-- 字典种子数据（原 docker/mysql/init/002_data.sql 迁入）
-- 依据：docs/architecture/adr/ADR-002-database-single-source.md
-- 幂等：INSERT IGNORE 依赖 sys_dict.uk_type_code(type, code)，可重复执行
-- ====================================

INSERT IGNORE INTO sys_dict (type, code, label, sort_order, status) VALUES
-- 简历状态
('resume_status', 'pending', '待解析', 1, 'active'),
('resume_status', 'parsing', '解析中', 2, 'active'),
('resume_status', 'success', '已解析', 3, 'active'),
('resume_status', 'failed', '解析失败', 4, 'active'),

-- 候选人状态
('candidate_status', 'active', '有效', 1, 'active'),
('candidate_status', 'inactive', '无效', 2, 'active'),
('candidate_status', 'blacklist', '黑名单', 3, 'active'),

-- 候选人来源
('candidate_source', 'upload', '手动上传', 1, 'active'),
('candidate_source', 'referral', '内推', 2, 'active'),
('candidate_source', 'talent_pool', '人才库', 3, 'active'),

-- 学历
('education_level', 'high_school', '高中', 1, 'active'),
('education_level', 'junior_college', '大专', 2, 'active'),
('education_level', 'bachelor', '本科', 3, 'active'),
('education_level', 'master', '硕士', 4, 'active'),
('education_level', 'doctor', '博士', 5, 'active'),

-- 用户角色（与 com.recruit.common.Roles 一致）
('user_role', 'ADMIN', '管理员', 1, 'active'),
('user_role', 'HR', 'HR专员', 2, 'active'),
('user_role', 'INTERVIEWER', '面试官', 3, 'active'),

-- 标注状态
('annotation_status', 'pending', '待标注', 1, 'active'),
('annotation_status', 'reviewed', '已审核', 2, 'active'),
('annotation_status', 'trained', '已训练', 3, 'active'),
('annotation_status', 'discarded', '已丢弃', 4, 'active');
