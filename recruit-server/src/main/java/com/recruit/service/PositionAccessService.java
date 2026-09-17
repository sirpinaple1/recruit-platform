package com.recruit.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.recruit.common.MyException;
import com.recruit.entity.HrRequest;
import com.recruit.entity.SysUser;
import lombok.extern.log4j.Log4j2;
import org.springframework.stereotype.Service;

/**
 * 岗位归属授权判定（唯一真源）
 *
 * <p>实现 ADR-008 资源归属授权模型。岗位归属由 hr_request.owner_user_id 表达，
 * 本服务提供统一的判定逻辑：</p>
 * <ul>
 *   <li>ADMIN：可见全部、可操作全部</li>
 *   <li>HR（owner）：可见/可操作自己负责的岗位</li>
 *   <li>HR（非owner）：不可见、不可操作</li>
 *   <li>owner_user_id IS NULL：对 HR 一律不可见/不可操作（fail-closed），仅 ADMIN 可见</li>
 * </ul>
 *
 * <p><b>为什么在 Service 层而非拦截器</b>：本需求的核心是查询过滤（viewScope），
 * 过滤条件必须参与 SQL 构造。拦截器只能"放不放行"，无法提供查询条件。</p>
 *
 * @see <a href="../../../../../../docs/architecture/adr/ADR-008-resource-ownership-authorization.md">ADR-008</a>
 */
@Log4j2
@Service
public class PositionAccessService {

    /**
     * 判定用户是否可查看指定岗位
     *
     * @param request 岗位实体（必须包含 owner_user_id）
     * @param user 当前用户（必须包含 role）
     * @return true = 可查看
     */
    public boolean canView(HrRequest request, SysUser user) {
        if (request == null || user == null) {
            return false;
        }

        // ADMIN 可见全部
        if ("ADMIN".equals(user.getRole())) {
            return true;
        }

        // 未指派岗位对 HR 不可见（fail-closed）
        if (request.getOwnerUserId() == null) {
            return false;
        }

        // HR 仅可见自己负责的岗位
        return request.getOwnerUserId().equals(user.getId());
    }

    /**
     * 判定用户是否可操作指定岗位（修改、状态流转、发布回填等写操作）
     *
     * <p>当前实现：操作权限 = 查看权限。后续如需细化（如"owner 可编辑但只有审批人可审批"），
     * 在此方法内扩展，调用方无需改动。</p>
     *
     * @param request 岗位实体
     * @param user 当前用户
     * @return true = 可操作
     */
    public boolean canOperate(HrRequest request, SysUser user) {
        return canView(request, user);
    }

    /**
     * 写操作前置校验，不通过直接抛 403
     *
     * <p>用于需要明确拒绝越权请求的写接口（update / 状态流转 / 发布回填）。</p>
     *
     * @param request 岗位实体
     * @param user 当前用户
     * @throws MyException 403 Forbidden，附带清晰的提示
     */
    public void assertCanOperate(HrRequest request, SysUser user) {
        if (!canOperate(request, user)) {
            String msg = request.getOwnerUserId() == null
                    ? "该岗位未指派负责人，仅管理员可操作"
                    : "无权操作该岗位（仅负责人或管理员可操作）";
            log.warn("归属校验拒绝：user={} role={} 尝试操作 request={} owner={}",
                    user.getId(), user.getRole(), request.getId(), request.getOwnerUserId());
            throw new MyException(403, msg);
        }
    }

    /**
     * 构造查询条件：根据用户角色返回归属过滤条件
     *
     * <p>用于 list 类接口，确保查询结果只包含用户可见的岗位：</p>
     * <ul>
     *   <li>ADMIN：返回空 wrapper（不加过滤 = 查全部）</li>
     *   <li>HR：返回 owner_user_id = 当前用户 的条件</li>
     * </ul>
     *
     * <p><b>使用示例</b>：</p>
     * <pre>
     * LambdaQueryWrapper&lt;HrRequest&gt; wrapper = positionAccessService.viewScope(user);
     * wrapper.eq(StringUtils.hasText(status), HrRequest::getStatus, status)
     *        .orderByDesc(HrRequest::getId);
     * return hrRequestMapper.selectPage(Page.of(page, size), wrapper);
     * </pre>
     *
     * @param user 当前用户
     * @return 查询条件包装器（已应用归属过滤）
     */
    public LambdaQueryWrapper<HrRequest> viewScope(SysUser user) {
        LambdaQueryWrapper<HrRequest> wrapper = new LambdaQueryWrapper<>();

        if (user == null) {
            // 未登录 = 空结果（加一个永假条件）
            log.debug("viewScope: user=null, 返回空结果集");
            wrapper.eq(HrRequest::getId, -1L);
            return wrapper;
        }

        // ADMIN 不加过滤
        if ("ADMIN".equals(user.getRole())) {
            log.debug("viewScope: user={} role=ADMIN, 不加过滤（查全部）", user.getId());
            return wrapper;
        }

        // HR 只看自己负责的岗位
        log.debug("viewScope: user={} role={}, 过滤条件 owner_user_id={}",
                user.getId(), user.getRole(), user.getId());
        wrapper.eq(HrRequest::getOwnerUserId, user.getId());
        return wrapper;
    }
}
