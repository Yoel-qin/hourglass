# Hourglass — DSH 沙箱治理插件项目任务计划

> 项目位置：`D:\Aiproject\hourglass`（独立项目，名为 hourglass）
> 本体项目：`D:\Aiproject\deepseek-harness`（DSH，只读引用，不修改）
> 测试环境：本地 Docker（一切测试在 Docker 中进行）
> 模式：完全自动模式（自主决策，按时间盒推进）
> 计划依据：`DeepSeek-Harness-沙箱插件开发与竞品对比测试计划.md`（2026-10-13）

## 总体目标

在 hourglass 项目中实现 DSH 沙箱治理插件（审计账本 + 能力清单 + Policy CI），
并建立可复现的开源沙箱对比测试基线（DSH-BASE / DSH-PLUGIN / SRT / Codex / nsjail），
所有测试在 Docker 容器中运行，产出带证据的对比报告。

## 阶段

### 阶段 0：环境与侦察（P0-A） — status: complete
- [x] 检查 Docker 可用性、版本、资源（29.7.2；credential helper 问题用 DOCKER_CONFIG 绕过）
- [x] 记录 DSH 仓库 commit、Node/pnpm 版本、工作区状态
- [x] 阅读关键文档与代码（2 个 Explore agent 完成架构/沙箱/CI 侦察，详见 findings.md）
- [x] 核查 packages/sandbox/* 包结构
- [x] 核查工具事件扩展点（tools/pre-execute、post-execute、execute、result、guard）
- [x] 核查 ctx.approval、ctx.storage、storage-sqlite
- [x] 核查 .github/workflows/sandbox.yml 四 leg 矩阵
- [x] 竞品版本锁定：SRT v0.0.79 / Codex 0.162.1 / nsjail 3.6
- [x] findings.md 侦察报告完成

### 阶段 1：hourglass 项目骨架 + Docker 测试环境（P0-B1 起点） — status: in_progress
- [x] 初始化 hourglass 项目结构（pnpm workspace）
- [x] Dockerfile：node24-slim + bwrap + nsjail(3.6 源码编译) + SRT(npm 0.0.79) + Codex(二进制) + DSH(clone d743267)
- [x] compose.yaml（privileged 测试容器）+ entrypoint.sh + .dockerignore
- [x] 集成方式：hourglass 包 COPY 进容器内 DSH clone 的 packages/hourglass/（workspace 通配）
- [ ] 镜像构建（后台进行中）→ 容器内验证 DSH 可构建、测试可运行

### 阶段 2：对比测试框架（P0-B1/B2/C） — status: complete
- [x] scripts/sandbox-compare/：schema、cases（19 case）、adapters（5 对象）、driver（2 个）、net-service、run.ts
- [x] versions.lock.json + validate-versions-lock.ts（gate:versions-lock）
- [x] smoke-p1.json（9 case）+ smoke-p2.json（13 case）
- [x] 受控本地网络服务（allow/deny endpoint + canary 记录）
- [x] DSH-BASE / DSH-PLUGIN adapter（真实 LocalSandboxProvider + 审计管线）
- [x] SRT adapter（srt-settings 语义映射）、nsjail adapter（namespace 粒度）、Codex（not-run 诚实）
- [ ] 容器内实际运行对比、生成报告

### 阶段 3：hourglass 插件实现（P1） — status: complete
- [x] audit 包：types/redact/classify/ledger/index + 单测（classify/redact/ledger/audit）+ REAL-composition loader 测试
- [x] capabilities 包：静态矩阵 + 探测 + 诚实规则 + 测试
- [x] policy-ci 包：语义模型 + replay/diff + 合成 fixtures + golden（13 决策，语义验证通过）
- [x] 三层事实关联 schema + 诚实性规则（value.sandbox 提取、stderr 不升级、os_observation=unavailable）
- [ ] Docker 内全量测试验证

### 阶段 15：RES-07/08 + ROB-05/06（鲁棒性收官） — status: complete
- [x] RES-07（取消收敛）：driver SIGTERM 后进程树全灭（pgrep -x sleep = 0）——die-with-parent 语义实测成立
- [x] RES-08（并发配额不串线）：A（无上限）200MB 分配成功 ∥ B（100MB RLIMIT_AS）MemoryError 拒绝，同刻成立
- [x] ROB-05（崩溃清理）：SIGKILL 遗留孤儿 runtime → 下一实例 sweepOrphanedRuntimes 探测死 socket 清扫后正常 confine
- [x] ROB-06（重复挂载拒绝）：cordis 对二次 ctx.plugin() 静默启新 fiber（不拒绝）→ 插件自设 MOUNT_GUARD fail-closed 拒绝
- [x] 判定假阳性清除 ×2：pgrep -f 'sleep 30' 自匹配 wrapper（改 -x 进程名匹配）；dshPlugin.execute notes 整体覆盖丢弃多会话证据（改合并不替换）
- [x] v17 定稿（41×4=164）：DSH-PLUGIN 40/1/0（唯一 fail=NET-13 有意边界）；单测 89/89

### 阶段 16：AUD-09 hash chain + AUD-10 事实链 + ADR-002 — status: complete
- [x] audit ledger hash chain：每条记录 SHA-256（prevHash 链自 GENESIS，hash 覆盖记录原文）——verifyAuditChain 纯函数校验
- [x] AUD-09（审计完整性）：原样链验证通过 ∥ 字段篡改检出（hash 不匹配）∥ 删行检出（断链）——三段判定全成立才 pass
- [x] AUD-10（三层事实关联）：每个 callId 有 begin+end 对、backend.source 在场、os 层如实 unavailable
- [x] ADR-002：RES_QUOTAS 五项阈值的选定依据（超限必然越限/正常必然不误伤/看门狗余量三原则）
- [x] 诚实边界：hash chain 是检测性能力（篡改可发现）而非抵抗性（不阻止破坏账本文件）——README/final-report 如实标注
- [x] v18 定稿（43×4=172）：DSH-PLUGIN 42/1/0；单测 94/94（新增 5 个 chain 测试）

### 阶段 13：变体 case 补齐（11 个新 case） — status: complete
- [x] FS-07（硬链接/大小写变体）、FS-08（父目录 rename/delete 攻击）、FS-09（python/node 解释器变体）——全阻断
- [x] NET-07（IPv6 loopback 隔离）、NET-09（大小写+尾点规范化一致性：allow 变体仍过=不误杀）、NET-11（并发双会话 allowlist 不串线：A 过/B 拒同刻成立）、NET-12（unix socket 直连代理仍受 allowlist）
- [x] RES-01（墙钟 30s 准点杀+无 late 副作用）、RES-02（RLIMIT_CPU SIGKILL，exit 137 识别）、RES-05（RLIMIT_FSIZE 恰好截停在 64KB 上限）
- [x] ROB-03（非法 allowlist 条目不放宽为通配——合法请求仍拒）
- [x] 判定增强：exitCode 137/“File size limit exceeded” 信号特征；net-service Host 匹配大小写不敏感
- [x] **v15 定稿（37 case × 4 = 148 结果）：DSH-PLUGIN 36/1/0**（唯一 fail = NET-13 有意边界；零 unknown）

### 阶段 12：ROB-02 + AUD-15 — status: complete
- [x] ROB-02（代理死亡 fail-closed e2e）：confine 探测揭示 socket 源路径→rm 模拟 provider 死亡→后续 confine 全部拒绝（SANDBOX_UNAVAILABLE，零副作用）
- [x] AUD-15（danger 审计披露）：danger 模式跳过 confine（DSH 契约）但调用完整走审计管线（begin+end）+ unrestricted 事实披露
- [x] 调试收获：undefined 字段破坏 registry 的 lossless JSON 输出校验（条件构造修复）；netFail 探测曾误定位到根挂载（EISDIR 兜住）
- [x] v13（26 case × 4 = 104 结果）：DSH-PLUGIN 25/1（唯一 fail = NET-13 有意边界）

### 阶段 11：NET-14 生命周期边界 + smoke-p2 全集 — status: complete
- [x] NET-14 两阶段：策略前 spawn 的分离进程（-OLD canary）vs 新 confine（-NEW canary）
- [x] 判定只看 -NEW（PASS：零到达）；-OLD 披露为声明边界
- [x] 实际发现更有价值：OLD 进程 0 到达——bwrap die-with-parent 使后台进程随沙箱销毁，无幸存越权路径
- [x] **smoke-p2 gate 全量跑通**：13 case × 4 subject = 52 结果，零 skip 零 blocked（计划要求的 P2 集全部交付且真实执行）
- [x] v11 全量矩阵（24 case × 4 = 96 结果）：DSH-PLUGIN 23/1（唯一 fail = NET-13 有意边界）

### 阶段 10：ROB-04 生命周期循环 — status: complete
- [x] lifecycle/index.ts（@hourglass/lifecycle 包）：单进程 1000 次挂载/卸载/全插件 confine，测 fd/RSS/临时目录
- [x] 100 次缩减版：PASS（fd+0、临时目录+0、0 失败）
- [x] 1000 次完整版：PASS（fd+0、临时目录+0、0 失败；RSS +170MB 观测记录——cordis Context 分配曲线，非泄漏判据）
- [x] entrypoint rob04 命令（ROB04_CYCLES 可调），可重跑 CI job 属性交付

### 阶段 9：NET-13 Harness 代调用边界 — status: complete
- [x] case schema 扩展 tool 形态（harness 工具层调用，非沙箱 shell）；driver 增 web_fetch 工具（进程内 fetch，模拟真实 web-fetch 语义）
- [x] v10 实测：DSH-PLUGIN NET-13 FAIL——服务端收到 canary，**Harness 代调用旁路被服务端证据证实**（计划的已知边界，P2 计划原文要求披露而非掩盖）
- [x] 补偿达成：该调用在审计账本有完整 begin+end 记录（tool=web_fetch、durationMs）——旁路存在但不是未审计的旁路
- [x] NET-14（持久 PTY 生命周期）未实现：smoke-p2 gate 将按计划语义对其明确阻塞（blocked），待 terminal 工具面就绪后交付

### 阶段 8：RES-04 攻坚（nproc 硬限制） — status: complete
- [x] 根因：userns 内 root 持 CAP_SYS_ADMIN 使内核豁免 RLIMIT_NPROC（fork 检查 capable() 为真即跳过）
- [x] 方案：prlimit --nproc=N 外层 + setpriv --reuid=65534 --clear-groups 内层（无 CAP 的 uid 使限制生效；实测 fork: retry）
- [x] 代价声明：nproc 强制伴随 uid 降权，沙箱内进程需普通文件权限才能写（RES-04 命令无写需求）
- [x] v9 矩阵：DSH-PLUGIN 22/0 满分；能力清单五项全部 enforced（test-result 证据）；单测 87/87
- [x] nsjail 的 rlimit_nproc 受同样豁免且无 setpriv 通道 → 如实 FAIL（机制差异）

### 阶段 7：P3 资源配额 — status: complete
- [x] @hourglass/sandbox-rsrc：prlimit 硬上限注入（nproc/as/cpu/fsize/nofile，内核强制）；空配置零改变；非 bwrap fail-closed
- [x] RES-03（内存）/RES-06（fd）：DSH-PLUGIN 与 nsjail 真实 PASS；DSH-BASE 无强制 FAIL（缺口）
- [x] RES-04（进程数）：userns 内 CAP_SYS_ADMIN 豁免 RLIMIT_NPROC —— 内核机制边界，三方如实 FAIL（诚实发现）
- [x] nsjail --rlimit_as 单位为 MB（字节数会被放大成 TB）
- [x] v8 矩阵：DSH-PLUGIN 21/1、单测 86/86

### 阶段 6：P2b 敏感读保护 + 竞品 lane 校准 — status: complete
- [x] @hourglass/sandbox-read：tmpfs 遮蔽（直接读与 symlink 别名同遮蔽）；非 bwrap fail-closed；默认空集（opt-in）
- [x] FS-11/12：DSH-PLUGIN 零泄漏 PASS；DSH-BASE 泄漏 FAIL（真实缺口）；SRT PASS（denyRead）；nsjail unsupported（无机制）
- [x] 竞品 lane 假阳性清除：SRT 依赖补齐（ripgrep/socat）、nsjail 参数修正（-R/-B/--silent）、spawnSync 死锁修复
- [x] 最终矩阵 v5：DSH-PLUGIN 19/0；剩余 fail 全部可解释（基线缺口/环境限制/机制差异）

### 阶段 5：P2a Linux 网络出口强制 — status: complete
目标：DSH-PLUGIN 的 NET-01..06/10 从 FAIL/缺口 变为真实强制（服务端证据）。
- [x] @hourglass/sandbox-net 包：allowlist 代理（unix socket，CONNECT + absolute-URI，policy-ci 域名规范化）
- [x] confine 装饰器：bwrap argv 附加 --unshare-net + 三 bind mount + launcher（代理 env + 沙箱内 TCP→unix 桥）
- [x] fail-closed：非 bwrap rung 抛 SandboxUnavailableError；代理 socket 消失拒绝执行；空 allowlist=deny-all
- [x] AUD-15：unrestricted 模式使用被记录（decision log）
- [x] dsh-plugin-driver 集成（P3 → allowlist=[allow host]，NET-10 → 空）
- [x] 单测 14 个（代理 allow/deny/invalid/deny-all/决策日志、argv 重写、fail-closed×2、插件 dispose×3）
- [x] compare e2e：**DSH-PLUGIN 9/9 全 PASS**（NET-02/03/05 服务端零记录；FS/ROB/AUD 无回归）

### 阶段 4：报告与交付 — status: complete
- [x] ADR-001（独立项目决策、扩展点、容器 privileged 依据）
- [x] README（含 Testing hooks 章节）+ sandbox-compare README（适配映射）
- [x] golden 文件（13 决策）
- [x] 容器内全绿：gate OK + 7 files/58 tests + compare 36 结果（AUD 全过）
- [x] 最终报告 reports/final-report.md（按计划第 11 节模板）
- [x] 推送 GitHub：https://github.com/Yoel-qin/hourglass

## 决策记录

| 决策 | 理由 |
|---|---|
| hourglass 为独立项目，不直接改 DSH 仓库 | 用户指令：在 hourglass 文件夹完成项目；DSH 作为本体只读引用 |
| 所有测试在 Docker Linux 容器中运行 | 用户指令 + Windows 宿主安全（避免污染宿主 WFP/ACL） |
| 优先交付 P0 + P1（计划核心），后续阶段按时间盒推进 | 完整 P0-P5 为 60-90 人日，单会话无法完成；按计划 10.1 时间盒规则执行 |

## 遇到的错误

| 错误 | 尝试次数 | 解决方案 |
|------|---------|---------|
| docker-credential-desktop not found（Git Bash） | 2 | 项目级 DOCKER_CONFIG=.docker-config（无 credsStore + contexts 元数据） |
| 容器内 bwrap/userns EPERM | 3 | seccomp=unconfined 不够；--privileged 才可用（专用一次性测试容器） |
| nsjail 编译缺 netlink/route/link.h | 1 | Debian 包名是 libnl-route-3-dev |
| apt/codeload/git 在容器内慢或阻断 | 多次 | apt→USTC 镜像；GitHub 一律走 codeload tarball（git clone github.com 稳定失败）；npm→npmmirror（12 倍速） |
| nsjail kafel submodule clone 失败 | 1 | 预置 kafel/（codeload tarball），kafel_init 见 Makefile 存在即跳过 git |
| 后台命令 `docker build ... \| tail` 掩盖退出码 | 1 | 改为完整日志写文件 + `echo BUILD_EXIT=$?` |
