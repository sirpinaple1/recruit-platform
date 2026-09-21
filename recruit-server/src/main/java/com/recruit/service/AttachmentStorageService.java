package com.recruit.service;

import com.recruit.common.MyException;
import lombok.extern.log4j.Log4j2;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

/**
 * 附件文件存储（框架 §2 Phase 2.1）。
 *
 * <p>当前实现为本地磁盘：{@code <root>/<platform>/<yyyyMM>/<净化后的platformFileId>.<ext>}。
 * 用 yyyyMM 分片是为了避免单目录文件数过多。</p>
 *
 * <p>为什么不上 MinIO：docker-compose 虽已 provision MinIO，但后端代码此前完全未接线，
 * 一期引入属于过度设计（recruit-server/AGENTS.md：不做过度设计）。
 * 存储动作全部收敛在本类，Phase 2 需要时整体替换，调用方不动。</p>
 *
 * <p>路径安全：platformFileId / fileName 都来自平台（不可信输入），
 * 必须净化后再拼路径，且拼完要校验仍在 root 之内 —— 否则 {@code ../} 可穿越到存储根之外。</p>
 */
@Log4j2
@Service
public class AttachmentStorageService {

    private static final DateTimeFormatter MONTH = DateTimeFormatter.ofPattern("yyyyMM");
    private static final int MAX_EXT_LEN = 8;
    private static final int MAX_BASE_LEN = 120;
    /** 临时文件后缀。**不要**在别处另写一份字面量：清扫、写入、判废必须同一口径。 */
    private static final String TMP_SUFFIX = ".tmp";
    /** 启动清扫的目录深度上限：<platform>/<yyyyMM>/<file> 只需 3 层，留 1 层余量 */
    private static final int SWEEP_MAX_DEPTH = 4;
    /** 启动清扫的文件数上限，避免存储根异常膨胀时把启动拖死 */
    private static final long SWEEP_MAX_FILES = 50_000;

    private final Path root;

    /**
     * 「原子替换是否可用」的进程级记忆。
     *
     * <p>首次失败后置 false，此后一律直写 —— 理由见 {@link #writeAtomicOrDirect}：
     * 在「允许写、禁止 unlink」的受限环境里，每次尝试原子替换都会白留一个 .tmp。</p>
     */
    private volatile boolean atomicReplaceUsable = true;

    public AttachmentStorageService(
            @Value("${app.storage.attachment-root:./data/attachments}") String rootDir) {
        this.root = Paths.get(rootDir).toAbsolutePath().normalize();
        try {
            Files.createDirectories(this.root);
        } catch (IOException e) {
            // 启动即失败优于运行期才暴露：附件目录不可写属于部署配置错误
            throw new IllegalStateException("附件存储根目录不可创建: " + this.root, e);
        }
        log.info("附件本地存储根目录: {}", this.root);
        sweepStaleTempFiles();
    }

    public Path getRoot() {
        return root;
    }

    /**
     * 生成存储相对路径。<b>必须确定性</b>：同一附件重复上传落到同一路径，避免产生孤儿文件。
     */
    public String buildKey(String platform, String platformFileId, String fileName) {
        String base = sanitize(platformFileId);
        if (base.isEmpty()) {
            base = "unnamed";
        }
        return sanitize(platform) + "/" + LocalDate.now().format(MONTH) + "/" + base + extensionOf(fileName);
    }

    /**
     * 落盘入口：返回相对 key、字节数与摘要，供调用方写库。
     */
    public Stored store(String storageKey, byte[] content) {
        Path target = resolveSafely(storageKey);
        try {
            Files.createDirectories(target.getParent());
        } catch (IOException e) {
            throw new MyException(500, "附件落盘失败（目录不可创建）: " + e.getMessage());
        }
        writeAtomicOrDirect(target, content);
        return new Stored(storageKey, content.length, sha256Hex(content));
    }

    /**
     * 写入内容：优先「临时文件 + 原子替换」，失败则退化为直写，并**记住这次失败**。
     *
     * <p><b>为什么必须留退路（2026-09-21 真机踩到）</b>：原实现只有
     * {@code Files.move(tmp, target, REPLACE_EXISTING, ATOMIC_MOVE)} 一条路。
     * 真机上出现 {@code Operation not permitted}：
     * 临时文件**写成功了**（220 KB 真 PDF 落在盘上）、只有 rename 那一步被拒
     * —— 这正是一个「允许 file-write-create/data、拒绝 file-write-unlink」
     * 的受限执行环境（macOS seatbelt 一类）的典型表现，因为 rename 需要 unlink 源条目。
     * 结果是附件永远入不了库，且每次失败都在数据目录里留下一个 .tmp 垃圾。</p>
     *
     * <p><b>为什么失败一次后就再也不试原子路径</b>：环境能力（能否 unlink）在一次进程
     * 生命周期内不会自我修复，而每试一次都要多写一份等大的 .tmp，在同样删不掉的环境里
     * 就是纯粹的垃圾累积。用 {@link #atomicReplaceUsable} 记住判定结果即可 ——
     * 首次失败已经证明这条路不通，后面直接走通的那条。</p>
     *
     * <p>退化直写为什么是安全的：本类当前**没有读回路径**的写入侧依赖
     * （{@code status} 只有在 {@link com.recruit.service.CollectService}
     * 用本次返回值写库后才置为 {@code stored}），中断留下的半截文件不会被当成完整件。
     * 2026-09-21 起 {@code CandidateQueryService} 会读回正文，但它按 {@code status=stored}
     * + 文件存在两重判断，同样不会把半截件当完整件。</p>
     */
    private void writeAtomicOrDirect(Path target, byte[] content) {
        if (atomicReplaceUsable) {
            Path tmp = target.resolveSibling(target.getFileName() + TMP_SUFFIX);
            try {
                Files.write(tmp, content);
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                return;
            } catch (IOException e) {
                atomicReplaceUsable = false;
                log.warn("原子落盘不可用，本进程后续一律直写（{}）: {}", e.toString(), target);
                // 失败时清掉半截临时文件，不再留垃圾
                discardTempFile(tmp);
            }
        }
        try {
            Files.write(target, content);
        } catch (IOException e) {
            throw new MyException(500, "附件落盘失败: " + e.getMessage());
        }
    }

    /**
     * 尽力丢掉一个临时文件：先试删除，删不掉就截成 0 字节。
     *
     * <p>为什么删不掉还要截断：受限环境下被拒的是 unlink，写入通常是允许的
     * （这正是它「允许写、禁止 unlink」的定义）。截成 0 字节能让它一眼被认出是垃圾，
     * 而不是像 2026-09-21 那样留一个与正文等大的 .tmp，让排查者误判「文件其实写成了」；
     * 顺带也把那份多余正文的容量省回来。</p>
     */
    private void discardTempFile(Path tmp) {
        try {
            Files.deleteIfExists(tmp);
            return;
        } catch (IOException e) {
            // 落到下面截断
        }
        try (var ch = Files.newByteChannel(tmp, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING)) {
            // 打开即截断，无需写入
        } catch (IOException ignore) {
            // 连截断都不被允许就彻底放弃：留一个 .tmp 不影响任何正确性，不该让落盘失败
        }
    }

    /** 启动兜底清扫（构造函数调用；失败只记日志，不影响启动） */
    private void sweepStaleTempFiles() {
        int swept = cleanupStaleTempFiles();
        if (swept > 0) {
            log.warn("附件目录启动清扫：丢弃 {} 个历史 .tmp（多为受限环境下原子替换失败留下的残留）", swept);
        }
    }

    /**
     * 清扫存储根下的全部 .tmp，返回处理数量。
     *
     * <p>为什么值得在启动时做一次：受限环境里每次原子替换失败都会留一个与正文等大的 .tmp，
     * 它们永远不会被读取，只占容量、且会干扰事后取证（2026-09-21 正是靠目录里那个
     * 220840 字节的 .tmp 才判明是受限环境，下一个排查者未必有这份上下文）。
     * 这是尽力而为的清理，不是正确性依赖 —— 所以任何异常都吞掉。</p>
     */
    public int cleanupStaleTempFiles() {
        AtomicInteger handled = new AtomicInteger();
        try (Stream<Path> walk = Files.walk(root, SWEEP_MAX_DEPTH)) {
            walk.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(TMP_SUFFIX))
                    .limit(SWEEP_MAX_FILES)
                    .forEach(p -> {
                        discardTempFile(p);
                        handled.incrementAndGet();
                    });
        } catch (Exception e) {
            log.warn("附件目录 .tmp 清扫未完成（不影响启动）: {}", e.toString());
        }
        return handled.get();
    }

    public byte[] load(String storageKey) {
        try {
            return Files.readAllBytes(resolveSafely(storageKey));
        } catch (IOException e) {
            throw new MyException(404, "附件读取失败: " + e.getMessage());
        }
    }

    public boolean exists(String storageKey) {
        return Files.exists(resolveSafely(storageKey));
    }

    /** 计算 SHA-256 十六进制（与 extension_token 的摘要口径一致） */
    public String sha256Hex(byte[] content) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content));
        } catch (Exception e) {
            throw new MyException(500, "计算附件摘要失败: " + e.getMessage());
        }
    }

    /** 拼接后必须仍在 root 之内，否则拒绝 */
    private Path resolveSafely(String storageKey) {
        if (storageKey == null || storageKey.isBlank()) {
            throw new MyException(400, "存储路径不能为空");
        }
        Path p = root.resolve(storageKey).normalize();
        if (!p.startsWith(root)) {
            throw new MyException(400, "非法存储路径");
        }
        return p;
    }

    /** 只保留字母数字、下划线、连字符与点；其余替换为下划线；折叠连续下划线 */
    private String sanitize(String raw) {
        if (raw == null) {
            return "";
        }
        String s = raw.trim().replaceAll("[^A-Za-z0-9._-]", "_").replaceAll("_{2,}", "_");
        if (s.length() > MAX_BASE_LEN) {
            s = s.substring(0, MAX_BASE_LEN);
        }
        return (".".equals(s) || "..".equals(s)) ? "" : s;
    }

    private String extensionOf(String fileName) {
        if (fileName == null) {
            return "";
        }
        int i = fileName.lastIndexOf('.');
        if (i < 0 || i == fileName.length() - 1) {
            return "";
        }
        String ext = fileName.substring(i + 1).replaceAll("[^A-Za-z0-9]", "");
        if (ext.isEmpty() || ext.length() > MAX_EXT_LEN) {
            return "";
        }
        return "." + ext.toLowerCase();
    }

    /** 存储结果 */
    public record Stored(String storageKey, long bytes, String sha256) {
    }
}
