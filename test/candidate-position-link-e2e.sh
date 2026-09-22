#!/usr/bin/env bash
# ============================================================
# 候选人 ↔ 职位关联 · 端到端回归
#   路径 A（发布回填自动捕获） + 路径 B（人工绑定） + 级联重算 + 静默失效守卫
#
# 依据：docs/design/candidate-position-linking.md
#
# 覆盖的验收点：
#   1. 规则下发含 jobIdKeys / jobHintKeys
#   2. 路径 A：发布回填报 platformJobId → publish_record 落 auto 映射
#   3. 采集自动归类：fields.jobId 命中映射 → candidate_application.request_id 直接落值
#   4. 映射未知时留 NULL（绝不猜）
#   5. 路径 B：人工改绑 → 级联重算（旧岗位回落、新岗位归类，**双向**）
#   6. 唯一键防线：岗位被第二条台账抢占 → 409，且事务整体回滚（状态不被部分提交）
#   7. 只有 published 台账可绑定 → 400
#   8. 非采集渠道（mock_demo）绑定 → 400：否则是「台账显示已关联、投递永远归不了类」的静默失效
#   9. 权限：无 JWT → 真 HTTP 401
#
# 脚本**自足**：自己建需求单 → 提交 → 审批（生成各渠道 pending 台账），
# 不依赖库里已有的数据，可重复执行。
#
# 用法：
#   BASE=http://localhost:6018 ./test/candidate-position-link-e2e.sh
#
# ⚠️ 本脚本**写本地开发库**（新增 1 张需求单 + 2 位候选人 + 3 条投递）。
#    末尾打印清理 SQL。绝不要对生产库运行。
#
# 判据约定（同 RESUME_COLLECT_TEST_GUIDE.md）：业务错误是 HTTP 200 + body 里的 code
# （GlobalExceptionHandler 未加 @ResponseStatus）；只有拦截器层才是真 HTTP 401/403。
# ============================================================
set -uo pipefail

BASE="${BASE:-http://localhost:6018}"
MYSQL_CONTAINER="${MYSQL_CONTAINER:-recruit-mysql}"
MYSQL_PW="${MYSQL_PW:-recruit2024}"
MYSQL_DB="${MYSQL_DB:-recruit_platform}"

PASS=0
FAIL=0

db() {
  docker exec "$MYSQL_CONTAINER" mysql -uroot -p"$MYSQL_PW" --default-character-set=utf8mb4 \
    -N -B "$MYSQL_DB" -e "$1" 2>/dev/null
}
code_of() { grep -o '"code":[0-9]*' | head -1 | cut -d: -f2; }
str_of()  { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check() { if [ "$1" = "$2" ]; then ok "$3（=$1）"; else bad "$3：期望 $2，实际 ${1:-<空>}"; fi; }

echo "============================================================"
echo "候选人 ↔ 职位关联 端到端回归   BASE=$BASE"
echo "============================================================"

# ---------- 0. token ----------
JWT=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | str_of token)
if [ -z "$JWT" ]; then echo "❌ 无法登录取 JWT，终止"; exit 1; fi
EXT=$(curl -s -X POST "$BASE/api/extension/session-token" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"token":null}' | str_of token)
if [ -z "$EXT" ]; then echo "❌ 无法换扩展 token，终止"; exit 1; fi
echo "token 就绪：JWT=${#JWT} 字符, EXT=${#EXT} 字符"
echo

# ---------- 1. 规则下发 ----------
echo "[1] 规则下发（CollectRules → 扩展）"
RULES=$(curl -s "$BASE/api/ext/collect/rules" -H "X-Extension-Token: $EXT")
check "$(printf '%s' "$RULES" | code_of)" "200" "rules 接口 code"
check "$(printf '%s' "$RULES" | str_of version)" "boss-20260922-V3" "规则版本已递增"
for k in jobIdKeys jobHintKeys; do
  if printf '%s' "$RULES" | grep -q "\"$k\""; then ok "下发含 $k"; else bad "下发缺少 $k"; fi
done
echo

# ---------- 2. 自建需求单链，拿到 boss / mock_demo 两条台账 ----------
echo "[2] 自建需求单 → 提交 → 审批（生成各渠道 pending 台账）"
STAMP=$(date +%s)
REQ=$(curl -s -X POST "$BASE/api/hr-requests" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d "{\"title\":\"E2E关联验证-$STAMP\",\"deptName\":\"技术部\",\"headcountTotal\":2,
       \"jobDescription\":\"端到端验证用岗位（候选人职位关联）\",
       \"salaryMin\":15000,\"salaryMax\":25000,\"location\":\"深圳\",
       \"education\":\"本科\",\"experienceYears\":3}")
HRID=$(printf '%s' "$REQ" | str_of id)
check "$(printf '%s' "$REQ" | code_of)" "200" "建单 code"
if [ -z "$HRID" ]; then echo "❌ 建单失败，终止：$REQ"; exit 1; fi
curl -s -X POST "$BASE/api/hr-requests/$HRID/submit" -H "Authorization: Bearer $JWT" > /dev/null
RESP_AP=$(curl -s -X POST "$BASE/api/hr-requests/$HRID/approve" -H "Authorization: Bearer $JWT")
check "$(printf '%s' "$RESP_AP" | code_of)" "200" "审批 code"

PICK=$(db "SELECT r.id, r.request_id FROM publish_record r JOIN channel c ON c.id=r.channel_id
           WHERE c.code='boss' AND r.request_id=$HRID ORDER BY r.id LIMIT 1;")
RID=$(printf '%s' "$PICK" | awk '{print $1}')
REQID=$(printf '%s' "$PICK" | awk '{print $2}')
PICK_MOCK=$(db "SELECT r.id FROM publish_record r JOIN channel c ON c.id=r.channel_id
           WHERE c.code='mock_demo' AND r.request_id=$HRID ORDER BY r.id LIMIT 1;")
if [ -z "$RID" ]; then echo "❌ 审批未生成 boss 渠道台账，终止"; exit 1; fi
# ⚠️ 全角标点紧跟 $VAR 时必须写 ${VAR}：bash 会把全角字符吞进变量名（曾在此报 unbound）
echo "  boss 台账 id=${RID} → 需求 id=${REQID}；mock_demo 台账 id=${PICK_MOCK:-<无>}"
J1="E2E${STAMP}1"
J2="E2E${STAMP}2"
echo "  测试岗位 ID：J1=$J1  J2=$J2"
echo

# ---------- 3. 路径 A ----------
echo "[3] 路径 A：发布回填自动建立映射（auto）"
RESP=$(curl -s -X POST "$BASE/api/ext/records/$RID/report" \
  -H "X-Extension-Token: $EXT" -H 'Content-Type: application/json' \
  -d "{\"status\":\"published\",\"publishedUrl\":\"https://example.test/e2e-$STAMP\",\"platformJobId\":\"$J1\"}")
check "$(printf '%s' "$RESP" | code_of)" "200" "回填 code"
ROW=$(db "SELECT platform_job_id, platform_job_bind_source FROM publish_record WHERE id=$RID;")
check "$(printf '%s' "$ROW" | awk '{print $1}')" "$J1" "台账已记录平台岗位"
check "$(printf '%s' "$ROW" | awk '{print $2}')" "auto" "来源标记为 auto"
echo

# ---------- 4. 采集自动归类 ----------
echo "[4] 采集 → 投递事实：命中映射应直接归类"
UID_A="e2e-link-${STAMP}-a"
RESP_A=$(curl -s -X POST "$BASE/api/ext/collect/resumes" \
  -H "X-Extension-Token: $EXT" -H 'Content-Type: application/json' \
  -d "{\"platform\":\"boss\",\"consent\":{\"confirmed\":true,\"scene\":\"chat\",\"pageUrl\":\"https://www.zhipin.com/web/chat/e2e\"},\"candidates\":[{\"platformUserId\":\"$UID_A\",\"sourceChannel\":\"chat\",\"scene\":\"chat\",\"source\":\"chat\",\"fields\":{\"name\":\"E2E关联验证A\",\"jobId\":\"$J1\",\"bottomText\":\"E2E 沟通的职位-Java\"}}]}")
check "$(printf '%s' "$RESP_A" | code_of)" "200" "采集 code"
CAND_A=$(printf '%s' "$RESP_A" | str_of candidateId)
APP_A=$(db "SELECT IFNULL(request_id,'NULL'), SUBSTRING_INDEX(platform_job_hint,' ',1) FROM candidate_application WHERE candidate_id=$CAND_A;")
check "$(printf '%s' "$APP_A" | awk '{print $1}')" "$REQID" "投递已自动归类到该需求单"
check "$(printf '%s' "$APP_A" | awk '{print $2}')" "E2E" "平台原文提示已留存"
echo

# ---------- 5. 未知岗位留 NULL ----------
echo "[5] 映射未知的岗位：request_id 必须留 NULL（不猜）"
UID_C="e2e-link-${STAMP}-c"
RESP_C=$(curl -s -X POST "$BASE/api/ext/collect/resumes" \
  -H "X-Extension-Token: $EXT" -H 'Content-Type: application/json' \
  -d "{\"platform\":\"boss\",\"consent\":{\"confirmed\":true,\"scene\":\"chat\"},\"candidates\":[{\"platformUserId\":\"$UID_C\",\"scene\":\"chat\",\"fields\":{\"name\":\"E2E关联验证C\",\"jobId\":\"NOSUCHJOB${STAMP}\"}}]}")
CAND_C=$(printf '%s' "$RESP_C" | str_of candidateId)
check "$(db "SELECT IFNULL(request_id,'NULL') FROM candidate_application WHERE candidate_id=$CAND_C;")" \
      "NULL" "未映射岗位的投递未归类"
echo

# ---------- 6. 路径 B：改绑 + 级联双向 ----------
echo "[6] 路径 B：人工改绑 → 级联重算（双向）"
RESP_B=$(curl -s -X PUT "$BASE/api/publish-records/$RID/platform-job" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d "{\"platformJobId\":\"$J2\"}")
check "$(printf '%s' "$RESP_B" | code_of)" "200" "改绑 code"
check "$(db "SELECT platform_job_bind_source FROM publish_record WHERE id=$RID;")" "manual" "来源升格为 manual"
check "$(db "SELECT IFNULL(request_id,'NULL') FROM candidate_application WHERE candidate_id=$CAND_A;")" \
      "NULL" "旧岗位(J1)的投递已回落为未归类"

UID_B="e2e-link-${STAMP}-b"
RESP_B2=$(curl -s -X POST "$BASE/api/ext/collect/resumes" \
  -H "X-Extension-Token: $EXT" -H 'Content-Type: application/json' \
  -d "{\"platform\":\"boss\",\"consent\":{\"confirmed\":true,\"scene\":\"chat\"},\"candidates\":[{\"platformUserId\":\"$UID_B\",\"sourceChannel\":\"chat\",\"scene\":\"chat\",\"fields\":{\"name\":\"E2E关联验证B\",\"jobId\":\"$J2\"}}]}")
CAND_B=$(printf '%s' "$RESP_B2" | str_of candidateId)
check "$(db "SELECT IFNULL(request_id,'NULL') FROM candidate_application WHERE candidate_id=$CAND_B;")" \
      "$REQID" "新岗位(J2)的投递已归类"

curl -s -X PUT "$BASE/api/publish-records/$RID/platform-job" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d "{\"platformJobId\":\"$J1\"}" > /dev/null
check "$(db "SELECT IFNULL(request_id,'NULL') FROM candidate_application WHERE candidate_id=$CAND_A;")" \
      "$REQID" "改回 J1：A 重新归类"
check "$(db "SELECT IFNULL(request_id,'NULL') FROM candidate_application WHERE candidate_id=$CAND_B;")" \
      "NULL" "改回 J1：B 回落未归类"
echo

# ---------- 7. 唯一键防线 ----------
echo "[7] 唯一键防线：岗位被第二条台账抢占 → 409"
PICK2=$(db "SELECT r.id FROM publish_record r JOIN channel c ON c.id=r.channel_id
            WHERE c.code='boss' AND r.status='pending' AND r.request_id<>$HRID ORDER BY r.id LIMIT 1;")
if [ -n "${PICK2:-}" ]; then
  RESP_D=$(curl -s -X POST "$BASE/api/ext/records/$PICK2/report" \
    -H "X-Extension-Token: $EXT" -H 'Content-Type: application/json' \
    -d "{\"status\":\"published\",\"platformJobId\":\"$J1\"}")
  check "$(printf '%s' "$RESP_D" | code_of)" "409" "抢占已占用岗位被拒"
  check "$(db "SELECT status FROM publish_record WHERE id=$PICK2;")" "pending" "冲突后台账状态未被部分提交"
else
  echo "  ⏭️ 没有第二条 pending 的 boss 台账，跳过"
fi
echo

# ---------- 8. 静默失效守卫 ----------
echo "[8] 静默失效守卫：非采集渠道绑定必须被拒"
if [ -n "${PICK_MOCK:-}" ]; then
  # 先把它置为 published，否则会被「只有已发布可绑定」的状态守卫先拦下，
  # 从而**走不到**渠道守卫 —— 那样即使断定 code=400 也是判错了原因（实测踩过）。
  curl -s -X POST "$BASE/api/ext/records/$PICK_MOCK/report" \
    -H "X-Extension-Token: $EXT" -H 'Content-Type: application/json' \
    -d "{\"status\":\"published\",\"publishedUrl\":\"https://example.test/mock-$STAMP\"}" > /dev/null
  check "$(db "SELECT status FROM publish_record WHERE id=$PICK_MOCK;")" "published" "mock 台账已置为 published"

  RESP_F=$(curl -s -X PUT "$BASE/api/publish-records/$PICK_MOCK/platform-job" \
    -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
    -d "{\"platformJobId\":\"MOCK${STAMP}\"}")
  check "$(printf '%s' "$RESP_F" | code_of)" "400" "mock_demo 台账绑定被拒（400）"
  # 断言必须是「渠道守卫」而非「状态守卫」拦下的 —— 只对 code 会误判
  if printf '%s' "$RESP_F" | grep -q "不会生效"; then
    ok "拒绝原因点明了后果（不会生效）"
  else
    bad "拒绝原因不对，可能被错误的分支拦下：$(printf '%s' "$RESP_F" | head -c 200)"
  fi
  check "$(db "SELECT IFNULL(platform_job_id,'NULL') FROM publish_record WHERE id=$PICK_MOCK;")" \
        "NULL" "被拒后未留下任何映射残留"
else
  echo "  ⏭️ 无 mock_demo 台账，跳过"
fi
echo

# ---------- 9. 非 published 不可绑定 ----------
echo "[9] 只有 published 台账才能绑定"
PICK3=$(db "SELECT r.id FROM publish_record r JOIN channel c ON c.id=r.channel_id
            WHERE c.code='boss' AND r.status='pending' ORDER BY r.id LIMIT 1;")
if [ -n "${PICK3:-}" ]; then
  RESP_E=$(curl -s -X PUT "$BASE/api/publish-records/$PICK3/platform-job" \
    -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
    -d "{\"platformJobId\":\"X${STAMP}\"}")
  check "$(printf '%s' "$RESP_E" | code_of)" "400" "pending 台账绑定被拒（400）"
else
  echo "  ⏭️ 没有 pending 的 boss 台账，跳过"
fi
echo

# ---------- 10. 权限 ----------
echo "[10] 权限：无 JWT 访问人工绑定 → 真 HTTP 401"
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/publish-records/$RID/platform-job" \
  -H 'Content-Type: application/json' -d "{\"platformJobId\":\"$J1\"}")
check "$HTTP" "401" "未登录被拦截"
echo

# ---------- 汇总 ----------
echo "============================================================"
echo "结果：✅ 通过 $PASS 项，❌ 失败 $FAIL 项"
echo "============================================================"
echo "本次写入的测试数据（如需清理，自行执行）："
cat <<SQL
-- 台账绑定复位
UPDATE publish_record SET platform_job_id=NULL, platform_job_bind_source=NULL,
       platform_job_bound_by=NULL WHERE id=$RID;
-- mock_demo 台账复位为 pending
UPDATE publish_record SET status='pending', published_url=NULL, published_at=NULL
       WHERE id=${PICK_MOCK:-0};
-- 删除本次采集的候选人与投递
DELETE FROM candidate_application WHERE candidate_id IN
  (SELECT id FROM candidate WHERE name LIKE 'E2E关联验证%');
DELETE FROM resume_version WHERE candidate_id IN
  (SELECT id FROM candidate WHERE name LIKE 'E2E关联验证%');
DELETE FROM candidate WHERE name LIKE 'E2E关联验证%';
-- 删除本次建的需求单链（草稿/台账/事件）
DELETE FROM publish_record WHERE request_id=$HRID;
DELETE FROM publish_draft  WHERE request_id=$HRID;
DELETE FROM domain_event   WHERE aggregate_type='hr_request' AND aggregate_id=$HRID;
DELETE FROM hr_request     WHERE id=$HRID;
SQL

[ "$FAIL" -eq 0 ]
