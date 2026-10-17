# Progress — 会话日志

## 会话 1（2026-10-13 ~ 10-14）

### P0-A 侦察（完成）
- Docker 29.7.2；DOCKER_CONFIG 绕过 credential helper；容器 bwrap 需 --privileged
- 容器网络真相：Docker Desktop 注入静态代理 127.0.0.1:10808（容器内不可达）→ 显式
  build-arg 指向 host.docker.internal:10808；apt→USTC；GitHub→宿主预下载 vendor tarball
  （容器内 git clone github.com 稳定失败）；npm→npmmirror 直连（剥离代理）
- DSH master d743267 只读；2 个 Explore agent 完成全部侦察（findings.md）
- 竞品锁定：SRT 0.0.79 / Codex 0.162.1 / nsjail 3.6

### 代码（完成）
- packages/audit：审计账本 + 分类 + 脱敏 + 查询命令 + REAL loader 测试
  - 关键契约：bash 消费者把 sandbox 事实放 result.value.sandbox；denied 优先于 isError 判定
- packages/capabilities：静态矩阵 + 探测 + 诚实规则
- packages/policy-ci：语义模型 + 回放 diff + 合成 fixture + golden（13 决策）
- scripts/sandbox-compare：19 case、5 adapter、2 driver、本地 net 服务、版本锁 gate、
  smoke-p1/p2、零跳过 gate
- docker：三阶段镜像 + privileged compose + entrypoint（gates/unit/compare/run-all）

### 验证（完成，容器内实测）
- versions-lock gate：OK sha256=bffbc35f…
- 单测：**Test Files 7 passed (7) / Tests 58 passed (58)**（含 REAL-composition loader）
- 对比矩阵 smoke-p1（36 结果，run-…T011836Z）：
  | subject | pass | fail | unsupported |
  |---|---|---|---|
  | DSH-BASE | 4 | 3 | 2 |
  | DSH-PLUGIN | 6 | 3 | 0 |
  | SRT | 6 | 0 | 3 |
  | NSJAIL | 6 | 0 | 3 |
  - DSH-PLUGIN AUD-02/AUD-11 PASS（分类区分 + backend 结构化事实）
  - 6 个 fail 全部是 DSH 无网络隔离的真实缺口（NET-02/03/05 × BASE/PLUGIN）
  - DSH-PLUGIN 与 DSH-BASE 的 FS/ROB 完全一致（零语义漂移）

### 关键修复历程（容器内调试）
1. tsconfig extends 层级（容器内多一层 hourglass → ../../../）
2. strip-types 不支持参数属性（AuditLedgerError/AuditLedger 两处）
3. defineTool parameters 形状（字段平铺 + 字段内 required:true）
4. AUD 命令模板去掉 `|| true`（否则非零 exit 被吞、denied 检测失效）
5. bwrap ephemeral tmpfs /tmp → 测试 fixture 基目录移到 /root（DSH e2e 同款规避）
6. `docker build | tail` 掩盖退出码 → 前台构建 + BUILD_EXIT 检查
7. pnpm install 层剥离代理直连 npmmirror

### 交付状态
- 已推送：https://github.com/Yoel-qin/hourglass（private，master）

## 会话 1 续（2026-10-14，P2a）

- **@hourglass/sandbox-net**（P2a 网络出口强制）交付：
  - proxy.ts：unix socket HTTP 代理（CONNECT + absolute-URI），NET-09 域名判定，JSONL 决策日志
  - confine.ts：bwrap argv 重写（--unshare-net + 3×bind + launcher）；非 bwrap/无分隔符 fail-closed
  - index.ts：confine 方法替换（首调用 await 代理就绪）；unrestricted 零语义漂移 + AUD-15 记录；dispose 同步清理
- driver/adapter 集成：DSH-PLUGIN 全 case 走插件管线；P3 → allowlist
- 容器内调试修复：schemastery 无 .optional()；代理启动竞态（proxyReady await）；
  dispose 清理时序（同步 rm）；httpRequest 忘导入（转发挂起根因）；测试断言改行为式
  （cordis confine 每访问重绑定）
- **最终结果：单测 8 files/72 tests 全绿；compare DSH-PLUGIN 9/9 全 PASS
  （NET-02/03/05 服务端零 canary 记录），DSH-BASE 保持 4/3（缺口如实暴露）**

## 会话 1 续 2（2026-10-14，P2b + 竞品 lane 校准）

- **@hourglass/sandbox-read**（P2b denyRead）：tmpfs 遮蔽装饰器（6 测试）；
  P2 profile → readDeny=[sensitive]；FS-11/12 零泄漏（symlink 别名同遮蔽）
- **竞品 lane 修复（消除假阳性——本轮最重要的质量工作）**：
  - SRT 缺 ripgrep/socat 从未真正运行（deny PASS 全是假阳性）→ 补依赖后 SRT 真实工作
  - SRT NET-01 = 环境限制：其 SSRF 防护拒绝 loopback 与本机地址，单容器无法验证 allow 通道
  - nsjail `-Ro/-Rw` 非法参数（exit 255）、`-B '.'` 环境变量失效（全 rw 泄漏）、
    `--silent` 吞子进程 stdio → 三处修正后 nsjail 真实工作
  - net-service 改监听 0.0.0.0 + hosts 指向 eth0 IP
  - spawnSync 冻结事件循环导致进程内代理死锁 → plugin driver 改异步 spawn（P2a 链路修通根因）
  - bwrap 挂载点问题：--dir 在 ro 根不可用 → 挂载族迁至 /tmp/.hourglass（tmpfs）+ ready 握手
  - fixture 每 (subject×case) reset——消除跨 subject 的快照钝化
- **最终矩阵 v5（compare-all-v5）**：DSH-BASE 9/8（缺口真实）、DSH-PLUGIN 19/0（满分）、
  SRT 15/1（NET-01 环境限制）、NSJAIL 13/1（NET-01 机制性）；单测 78/78

## 会话 1 续 3（2026-10-14，P3 资源配额）

- **@hourglass/sandbox-rsrc**：prlimit 硬上限装饰器（8 测试，总计 86/86）
- RES-03/06：DSH-PLUGIN/nsjail 内核级真实拒绝；DSH-BASE 缺口
- RES-04：发现 userns 内 CAP_SYS_ADMIN 豁免 RLIMIT_NPROC（内核机制边界，三方一致 FAIL，
  进程数硬限制需 cgroup pids——后续工作）；nsjail --rlimit_as 单位是 MB（字节数→TB 假上限）
- v8 定稿矩阵：DSH-BASE 9/11/2、DSH-PLUGIN 21/1/0、SRT 15/1/6、NSJAIL 15/2/5

## 会话 2（2026-10-14，RES-04 攻坚）

- 根因确认：userns 内 root 的 CAP_SYS_ADMIN 使内核 fork 检查豁免 RLIMIT_NPROC
  （capsh --drop=all 在本环境 exec 任何二进制均 rc=126，弃用）
- 方案：prlimit --nproc=N + setpriv --reuid=65534 --clear-groups（实测 fork: retry 生效）
- v9：DSH-PLUGIN 22/0 满分；能力清单五项全部 enforced（test-result 证据）；单测 87/87

## 会话 2 续（PERF-01 基线）

- perf.ts 采样器（30 次/对象，median/p95/min/max + 相对开销）+ entrypoint perf 命令
- 结果：bare 4ms；DSH-BASE 138ms；DSH-PLUGIN 243ms（+105ms 端到端，主要为 driver 进程/管线成本）；
  SRT 288ms；nsjail 9ms
- 钩子级 micro-bench：审计 append 0.0113ms/记录（≈0.023ms/调用对）——§6.3 的 5ms 目标余量约 200 倍

## 会话 2 续 2（NET-13）

- case schema + tool 形态；driver web_fetch 工具（进程内 fetch）；adapter tool 分支
- v10（23 case × 4 = 92 结果）：DSH-PLUGIN 22/1——唯一 fail 是 NET-13 的**有意边界暴露**：
  Harness 代调用旁路被服务端证据证实，且该调用有完整审计记录（非未审计旁路）——符合计划
  「分别记录边界，不得掩盖」的要求
- NET-14 未实现：smoke-p2 gate 按计划语义对其明确 blocked

## 会话 2 续 3（ROB-04）

- lifecycle 包（挂/卸/全插件 confine 循环 + fd/RSS/临时目录快照）
- 100 次缩减版 PASS；**1000 次完整版 PASS**（fd+0、tempDir+0、0 失败；RSS+170MB 观测项）
- 计划 §5.6 ROB-04 门达标；entrypoint rob04 命令交付为可重跑 job

## 会话 2 续 4（NET-14 + smoke-p2）

- NET-14 两阶段 case：-OLD（策略前 spawn）/-NEW（新 confine）canary 区分判定
- 发现：OLD 进程 0 到达——die-with-parent 使后台进程随沙箱销毁（无幸存越权路径）
- v11（24×4=96）：DSH-PLUGIN 23/1；smoke-p2 gate 全量跑通（13×4=52，零 skip 零 blocked）

## 会话 2 续 5（ROB-02 + AUD-15）

- ROB-02 PASS：socket 定位修复（目标路径反查源路径）；代理死亡→全 confine 拒绝
- AUD-15 PASS：danger 跳 confine 但审计完整；undefined 字段破坏 lossless JSON 校验（条件构造修复）
- v13（26×4=104）：DSH-PLUGIN 25/1

## 会话 2 续 6（变体 case 补齐）

- 11 个新 case 全过：FS-07/08/09、NET-07/09/11/12、RES-01/02/05、ROB-03
- 亮点：NET-11 并发双会话（A 放行/B 拒绝同刻成立）；RES-05 fsize 实测恰好截停在 64KB；
  RES-02 exit 137 信号识别；NET-09 大写+尾点 allow host 仍放行（不误杀）
- v15 定稿（37×4=148）：DSH-PLUGIN 36/1/0（唯一 fail=NET-13 有意边界，零 unknown）

## 会话 2 续 7（RES-07/08 + ROB-05/06）

- net 包：sweepOrphanedRuntimes（socket 存活探测，死 socket 目录清扫）+ MOUNT_GUARD 防重入（cordis 复用 runtime 静默启第二个 fiber，插件自身拒绝二次挂载）；单测 +2 → 89
- driver：doubleNet 请求字段（二次挂载 try/catch → duplicateRejected）
- 判定假阳性清除：①pgrep -f 'sleep 30' 匹配到判定自身的 sh -c wrapper（命令行含字面量）→ 改 pgrep -x sleep 进程名匹配，实测 ps 树本就零幸存；②adapter 返回 notes 整体覆盖 raw.notes → RES-08 会话 B 证据丢失 + MemoryError 在 driver JSON 前部而 slice(-140) 取尾部 → notes 合并 + memoryRefused 特征前置提取
- v17 定稿（41×4=164）：DSH-PLUGIN 40/1/0；其余 lane fail 数与 v15 完全一致（无回归）

## 会话 2 续 8（AUD-09/10 + ADR-002）

- ledger hash chain：append 建链（GENESIS→prevHash→hash 覆盖记录原文），verifyAuditChain 校验
  （篡改字段=hash 不匹配、删行/重排=断链，均报首个受影响 seq）
- driver auditChain 模式：原样 verify + 篡改副本（翻转 end 记录 outcome.kind）+ 删行副本，三段结果进响应
- AUD-09/10 case 判定只认响应字段（与 ROB-06 duplicateRejected 同模式）；判定 switch 补 tamper-detected/fact-chain 枚举
- ADR-002：RES_QUOTAS 阈值三原则（必然越限/不误伤/看门狗余量），满足计划"阈值须 ADR 确定"的诚实性规则
- v18 定稿（43×4=172）：DSH-PLUGIN 42/1/0；其余 lane 零回归；单测 94/94

## 会话 3（2026-10-17，竞品扩展轮）

- **三份源码级竞品调研**（Explore agent × 3）：SRT 0.0.80（三平台后端/智能代理/
  fail-closed 纪律/2330 测试）、wasmer 7.5（能力沙箱/--volume/ruleset/计量仅嵌入层）、
  Cube 0.7.3+14（KVM microVM 池/模板内存快照/reflink CoW/47.8ms 官方基准）
- **对比框架扩展**：WASMER subject（zig 0.13 编译 WASI 探针固件 fs_probe.zig，
  标记与既有判定正则同语言；--volume HOST:GUEST）+ CUBE subject（KVM/XFS/systemd
  探测 → 证据化 not-run）；versions.lock 增两 subject + fixtureToolchains +
  unsupportedDeclarations×5；entrypoint 增 compare-all / compare-cube
- **踩坑**：wasmer v7.5.0/v7.4.2 二进制需 GLIBC 2.38+（bookworm 2.36）→ 探测
  GLIBC 符号后锁 v7.3.0（2.34/3.4.30 兼容）；tarball 无顶层目录；python
  heredoc 把 \n 写成真实换行破坏 zig 字符串（Edit 修复）
- **v19 矩阵（43×5=215，compare-all-20261017T064348Z）**：DSH-PLUGIN 42/1/0；
  DSH-BASE 14/12/15+2u；SRT 19/2/22；NSJAIL 20/3/19+1u；WASMER 10/0/33
  （全部适用 case 真过，含 ROB-01 wasmer 断卷拒绝 rc=2 的真 fail-closed）
- **CUBE lane**：43 not-run（compare-cube-20261017T064756Z，/dev/kvm 缺失 +
  无 vmx 证据）；**PERF（perf-20261017T064810Z）**：bare 5ms / NSJAIL 11 /
  WASMER 40 / DSH-BASE 155 / DSH-PLUGIN 277 / SRT 322（median）
- **3 个 unknown**（BASE RES-02/05、NSJAIL RES-02）：limit-enforced 判定在收尾
  时序上的输出敏感，非本轮改动引入（判定逻辑零 diff）——如实披露
- 单测 94/94 绿；gates sha256=3baf3b24…
- **交付文档**：docs/competitive-analysis.md（七维度×三竞品 + 差距 G1-G7 +
  创新点三条含优先级）；README 重写（安装/配置/使用 + 实验对比环境/用例/数据/
  结论 + 两张 SVG 图表 docs/assets/）

## 会话 4（2026-10-17，桌面应用装载实战）

- **目标**：DSH 桌面应用（源码 dev 路线）装载 hourglass 插件并验证。
- **装载链路打通**：六包 fuse 进 DSH workspace + 根 devDeps（解析锚）+ tsc/tsdown
  排除（与 Docker 同型）+ 全量构建通过；dev 桌面启动。
- **三个装载坑（均实测复现并修复）**：
  1. dev 桌面用隔离 home（.desktop-build/development/home），非 ~/.dsh——补丁写错地方；
  2. 新增插件必须 `- insert:` 形态——id 覆盖形态被 loader warn 后静默跳过
     （vendor/include 补丁语义；由应用内 agent 定位到源码行）；
  3. 增删插件行需重启且进程树要杀净（旧 web server 占端口 → bind 失败）。
- **网络坑**：Electron 二进制直连极慢（ELECTRON_MIRROR=npmmirror 预装解决）；
  primary runtime 下载的 Node fetch 不认代理 → 按 lock.json sha256 预填
  .desktop-build/downloads 缓存（文件名即 sha256，命中免网）。
- **验证闭环（四道全过）**：账本落地（schema/策略快照/begin-end 配对/分类正确：
  栅栏拒绝=ordinary-failure、成功=allowed）；/sandbox-audit 在 GUI 接管执行；
  verifyAuditChain 原链 ok:true；篡改副本检出 firstBadSeq:5。
- **新观察**：fs 工具无 result.sandbox → backend 层 unavailable（设计内）；
  web_fetch 走宿主代理而沙箱 shell 直连被企业网络阻断——NET-13 边界的桌面端
  活体形态；/sandbox-capabilities 在个别客户端不被斜杠分发接管（宿主侧已注册，
  buildManifest 纯函数直调输出一致）；清单 absent=机制缺失≠环境可达性。
- README 新增"在 DSH 桌面应用中装载插件（源码路线）"完整章节。
