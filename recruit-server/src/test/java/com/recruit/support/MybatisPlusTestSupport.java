package com.recruit.support;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import org.apache.ibatis.builder.MapperBuilderAssistant;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 纯单测（无 Spring 上下文）下引导 MyBatis-Plus 实体元数据缓存。
 *
 * <p><b>为什么需要它</b>：MyBatis-Plus 的 {@code LambdaQueryWrapper} / {@code LambdaUpdateWrapper}
 * 在把 {@code SFunction}（如 {@code HrRequest::getStatus}）解析成列名时，依赖
 * {@code TableInfoHelper} 的实体缓存 + {@code LambdaUtils} 的列缓存。这两处缓存**只在
 * Spring 上下文启动、Mapper 被注册时才建立**。因此只要服务方法内部构造 Lambda wrapper
 * （如 {@code HrRequestService.reopen}、{@code PublishDraftService.cancelPendingByRequest}），
 * 脱离 Spring 直接 new 服务就会抛
 * {@code MybatisPlusException: can not find lambda cache for this entity [...]}。</p>
 *
 * <p>本工具按 {@link TableInfoHelper#initTableInfo} 的公开入口补齐这份缓存，
 * 让服务层可以真正跑「不依赖数据库/Redis 的纯单测」——安全回归控制（渲染白名单）
 * 不该因为需要 DB 而无法在 CI 跑。</p>
 *
 * <p>注意：这是测试侧的引导，不是生产代码的补丁。若某个服务的可测性长期依赖本工具，
 * 说明该服务把「纯逻辑」与「持久化副作用」耦合在了一起，应考虑抽出无副作用单元
 * （见评估报告的 P2 观察项）。</p>
 */
public final class MybatisPlusTestSupport {

    /** 幂等护栏：同一实体在单个 JVM 内只引导一次，避免重复注册列缓存 */
    private static final Set<String> INITIALIZED = ConcurrentHashMap.newKeySet();

    private MybatisPlusTestSupport() {
    }

    /** 引导给定实体的元数据缓存（可重复调用） */
    public static void initTableInfo(Class<?>... entityTypes) {
        for (Class<?> entityType : entityTypes) {
            if (!INITIALIZED.add(entityType.getName())) {
                continue;
            }
            MybatisConfiguration configuration = new MybatisConfiguration();
            MapperBuilderAssistant assistant = new MapperBuilderAssistant(configuration, "");
            TableInfoHelper.initTableInfo(assistant, entityType);
        }
    }
}
