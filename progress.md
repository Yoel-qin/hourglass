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
