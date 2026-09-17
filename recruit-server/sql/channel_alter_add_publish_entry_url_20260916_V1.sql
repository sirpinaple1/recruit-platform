SET NAMES utf8mb4;
-- ====================================
-- channel 增加发布页入口列 publish_entry_url
-- 依据：docs/design/channel-publish-seamless.md §7（发布页入口 URL，本轮阻塞项）
--
-- 背景（2026-09-16 只读核对本地库后的**修正版**结论）：
--
--      初判曾以为「BOSS 的 pattern 是通配串 → 撞上 background.js 的抛错分支」。
--      实测不成立：本地库两条渠道的 pattern 都是**具体 URL**，无通配：
--        · mock_demo = http://localhost:8430/publish-mock.html
--        · boss      = https://www.zhipin.com/web/frame/job/publish-edit?jobversion=11363&encryptId=0&enterSource=2
--      按 background.js 现有逻辑，两者都会走 tabs.create，不会抛错。
--
--      真实问题有三条（都是核对出来的，不是推测）：
--        (a) **一列两用**：publish_url_pattern 同时被当作「导航入口」和「注入校验模式」。
--            BOSS 塞的是完整业务 URL（带 jobversion / encryptId / enterSource 等易变
--            参数），其中 encryptId 疑似会话相关——作为**校验模式**它永远匹配不上
--            SPA 路由变化后的地址，作为**入口**它又随时可能失效。
--        (b) **真源漂移**：seed 文件里 mock_demo 的 pattern 仍是
--            `file://*publish-mock.html`（**含通配**），而库里的值已被手工改成
--            http 8430。即：本地能跑，但用该 seed 建出的**新库**点发布会直接抛错。
--            已在本批次同步修种子文件。
--        (c) **BOSS 渠道没有 seed 文件**：它只存在于本地库，新库拿不到，
--            导致「BOSS 单渠道跑通」这条验收在新环境无法复现。已补 seed。
--
--      所以本列的用途不是「修复某个立即崩溃的 bug」，而是把两个语义拆开，
--      让 (a) 的隐患有地方收敛、(b)(c) 的漂移有真源可依。
--
-- 两列的分工（不要混用、不要互相替代）：
--      publish_url_pattern = 「这里是不是对的地方」→ 扩展**校验**注入目标
--      publish_entry_url   = 「该去哪儿」           → 扩展**导航**
--
-- 为什么加列而不是塞进 field_map_json：
--      塞进 JSON 能省一次 DDL，但会把「导航」语义混进「字段映射」配置里——
--      前者作用于浏览器 tab，后者作用于表单控件，两件事放一起长期会别扭。
--      且加列后可被管理端编辑、可被 SQL 查询，符合 docs/design/channel-publish.md §5.2
--      「新增一个渠道 = 插一行数据，不改任何代码」的既有约定。
--
-- 存量数据：加列后为 NULL，需回填——NULL 表示「该渠道未配置入口」，
--      扩展遇到 NULL 应**明确报错而不是猜一个 URL**（猜错的代价是往错误页注入）。
--
--      回填规则（见 upgrade/channel_backfill_publish_entry_url_20260916_V1.sql）：
--      当前 pattern 事实上**就是**入口地址（它还兼任导航职责，见上文 (a)），
--      故把不含通配的 pattern 原值抄进 entry 列即可对齐现状。
--      含通配的 pattern 不参与回填（那才是真正反推不出的情形），留 NULL 待人工配置。
--
--      全新库无需回填：seed 文件已直接写入两列（本批次已同步
--      channel_seed_mock_demo_*.sql 与 channel_seed_boss_20260916_V1.sql）。
--
-- ⚠️ 执行顺序陷阱：db-bootstrap.sh 用 `ls sql/*.sql | sort` 全量执行，字典序下
--      `channel_alter_*` 排在 `channel_create_*` **之前**，故对「表尚不存在」必须跳过。
--      全新库由 channel_create_*.sql 保证（已同步补列），存量库靠本脚本收敛。
--
-- 幂等策略：查 information_schema 判表/列存在性后再 PREPARE/EXECUTE，可重复执行。
--
-- 注释收敛（第 2 段）：列注释**不引文档节号**，只引文档名。
--      原因：节号会随文档重构漂移，而列注释一旦落库就被冻结在 DB 里
--      （已有实例显示旧注释仍指向重构前的 §6），没人会回头扫全库改注释。
--      本脚本在「列已存在但注释与真源不一致」时才发 MODIFY COLUMN 收敛，
--      注释一致则完全跳过——保证重复执行依旧零改动。
-- ====================================

-- ---------- 0) 表 / 列存在性 ----------
SET @tbl_exists := (
    SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'channel'
);

SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'channel'
      AND COLUMN_NAME = 'publish_entry_url'
);

-- ---------- 1) 加列 ----------
SET @ddl := IF(@tbl_exists = 0,
    'SELECT ''channel 表不存在（全新库），跳过加列——由 channel_create_*.sql 负责'' AS note',
    IF(@col_exists > 0,
        'SELECT ''channel.publish_entry_url 已存在，跳过'' AS note',
        'ALTER TABLE channel ADD COLUMN publish_entry_url VARCHAR(512) NULL COMMENT ''发布页入口URL（扩展导航用；pattern仅用于校验注入目标。见docs/design/channel-publish-seamless.md）'' AFTER publish_url_pattern'
    )
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- 2) 注释收敛（列已存在时对齐 COMMENT，消除节号漂移） ----------
-- 与 channel_create_20260915_V1.sql 的列注释**必须逐字一致**，否则新库/老库注释分叉。
SET @want_comment := '发布页入口URL（扩展导航用；pattern仅用于校验注入目标。见docs/design/channel-publish-seamless.md）';

SET @cur_comment := (
    SELECT COLUMN_COMMENT FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'channel'
      AND COLUMN_NAME = 'publish_entry_url'
);

SET @ddl_comment := IF(@tbl_exists = 0 OR @col_exists = 0,
    'SELECT ''channel.publish_entry_url 尚不存在，跳过注释收敛'' AS note',
    IF(@cur_comment <=> @want_comment,
        'SELECT ''channel.publish_entry_url 注释已一致，跳过'' AS note',
        'ALTER TABLE channel MODIFY COLUMN publish_entry_url VARCHAR(512) NULL COMMENT ''发布页入口URL（扩展导航用；pattern仅用于校验注入目标。见docs/design/channel-publish-seamless.md）'' AFTER publish_url_pattern'
    )
);

PREPARE stmt3 FROM @ddl_comment;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;
