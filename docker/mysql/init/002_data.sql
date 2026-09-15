SET NAMES utf8mb4;
-- ====================================
-- 初始化数据脚本
-- ====================================

-- seed accounts: admin/admin123, hr001/hr123456 (BCrypt)
INSERT INTO sys_user (id, username, password, real_name, role, status) VALUES
(1, 'admin', '$2a$10$fXCKeAyxtbw/P2qlvMzrvO3EZtSDRbXVCxu7nwCv03nYLk7Wvgupy', '系统管理员', 'ADMIN', 'active'),
(2, 'hr001', '$2a$10$wAF4a73ZFo33vCwhPYZH9uZ/q1qPMVncJ1xSek1jdBgHaW5TMJAJm', 'HR张三', 'HR', 'active');

-- 插入枚举值字典
INSERT INTO sys_dict (type, code, label, sort_order, status) VALUES
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

-- 用户角色
('user_role', 'ADMIN', '管理员', 1, 'active'),
('user_role', 'HR', 'HR专员', 2, 'active'),
('user_role', 'INTERVIEWER', '面试官', 3, 'active'),

-- 标注状态
('annotation_status', 'pending', '待标注', 1, 'active'),
('annotation_status', 'reviewed', '已审核', 2, 'active'),
('annotation_status', 'trained', '已训练', 3, 'active'),
('annotation_status', 'discarded', '已丢弃', 4, 'active');
