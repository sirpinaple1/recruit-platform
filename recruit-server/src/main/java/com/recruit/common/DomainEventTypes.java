package com.recruit.common;

/**
 * 领域事件类型常量（命名约定：{@code <聚合>.<动作过去式>}，全小写）。
 *
 * <p>事件类型是代码契约而非可配置数据，故不进 {@code sys_dict}：改类型必须改代码，
 * 否则报表口径会静默漂移。</p>
 */
public final class DomainEventTypes {

    /** 聚合类型：人力需求单 */
    public static final String AGGREGATE_HR_REQUEST = "hr_request";

    /** draft -> pending_approval */
    public static final String HR_REQUEST_SUBMITTED = "hr_request.submitted";

    /** pending_approval -> open */
    public static final String HR_REQUEST_APPROVED = "hr_request.approved";

    /** pending_approval -> draft（驳回） */
    public static final String HR_REQUEST_REJECTED = "hr_request.rejected";

    /** open -> closed（人工关闭） */
    public static final String HR_REQUEST_CLOSED = "hr_request.closed";

    /** 招满自动关闭（系统触发；operator 记录触发修正的 HR） */
    public static final String HR_REQUEST_AUTO_CLOSED = "hr_request.auto_closed";

    /** closed -> draft */
    public static final String HR_REQUEST_REOPENED = "hr_request.reopened";

    private DomainEventTypes() {
    }
}
