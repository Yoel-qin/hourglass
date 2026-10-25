# Evolution v2 最终报告 — 自进化安全试炼场 MVP（feat/evolution-v2）

> 版本：v1.0（2026-10-24）。依据《自进化安全试炼场方案 v3.1》§17 验收标准。
> 全部数据为本机 Docker privileged 容器实测（A 级证据：真实 bwrap 后端 +
> 外部副作用判定），CI（GitHub Actions 容器 lane）复跑同一命令集。

## 1. 交付总览

| 里程碑 | PR | 交付 |
|---|---|---|
| E0/E1 | #2（直接推送） | ADR-003、E0 基线（12 条 DSH 源码核验）、`@hourglass/evolution-contract`（纯函数契约 + 16 场景 golden） |
| E2 | #2（直接推送） | `@hourglass/evolution-trial`（不可变候选库/hash-chain journal/launcher/验证包导出）+ 一次性受限 trial-driver 子进程 |
| E3 | #3→#4 | 端到端守门流水线（lock gate→封存→配对试炼→四态判定→验证包）+ 真实测试 CI + pr-agent 红叉语义 |
| E4 | #5 | entrypoint 接线（evolution-smoke/evolution-coverage）+ 两包 per-file 100% 覆盖门禁 + dsh-auto-evolve 证据化 not-run |
| 工具链 | #6→#7→#8 | pr-agent 专属身份（the-pr-agent-bot-for-hourglass[bot]，凭据隔离 + 最小权限令牌 + 降级告警）、master workflow 同步（仅 CI 配置，经所有者授权） |
| E5 | #9 | evolution-nightly 长循环演练、操作员 runbook、本报告 |

分支纪律：v2 全程在 `feat/evolution-v2` 集成，经"CI + PR Agent 双绿 +
意见修复"流程合入；master 仅含 CI 配置同步（48ee3b2，所有者授权），
功能代码零进 master；versions-lock sha256 与 master 一致（存量零改动）。

## 2. 验收对照（v3.1 §17 逐项）

| 验收项 | 状态 | 证据 |
|---|---|---|
| 资产范围：仅 `dsh_skill`/`prompt_fragment` | ✅ | schema 拒绝测试（EVO-CAND-01/05 golden + spec） |
| 不可变候选（哈希/父版本/版本锁绑定） | ✅ | `wx` 封存 + 封存后复验 + TOCTOU 测试（store.spec） |
| trial containment：独立子进程 + bwrap，非 vm/同进程 | ✅ | launcher.spec：driverPid ≠ 本进程 + 服务端 canary 零记录 |
| 宿主出口旁路：trial 无宿主出口工具 | ✅ | driver 唯一工具 `trial_exec`；EVO-TRIAL-11 判据 = 服务端 canary |
| OS 限制证据（5×5 能力矩阵，enforced 只认实测） | ✅ | run.ts：buildManifest + 活体 probeBwrap + v19 test-result 证据 |
| 冻结基准（公开/隐藏/安全集隔离，零跳过） | ✅ | evolution.lock.json（独立版本锁）+ 全量计数（12/8/4 阴性如实呈现） |
| 严格改进（阈值锁定、CI>0、安全不可抵消） | ✅ | evaluator golden 16 场景 + 判定器纯函数 |
| 持久化与日志（状态原子 + hash-chain journal） | ✅ | journal.spec：篡改/删行检出首个受损 seq |
| 人工晋级（仅验证包，不自动安装/不改 profile） | ✅ | promotion-policy：非 pass 不可导出；无任何 Plugin Manager 调用 |
| 测试环境恢复（prepare/commit/abort、dispose） | ⚪ 部分 | pack/journal 幂等重放已测；disposable profile 三段事务演练留待后续（MVP-A 无 profile 写路径，风险面不存在） |
| 资源与清理（wall-clock/nproc/fsize/as + 无孤儿进程） | ✅ | launcher.spec fsize 截停 + nightly 生命周期循环 fd 漂移 ≤10 |
| CI 真相（PR=smoke+coverage+unit+gates，不虚称平台） | ✅ | ci.yml 六步全容器真实执行；landlock/seatbelt/windows 未测即未标 |
| 覆盖率（evolution 两包 per-file 100% 真实触发） | ✅ | evolution-coverage gate exit=0（负向验证过阈值生效） |
| 安全证据（canary/快照/内核信号，stderr 非唯一依据） | ✅ | run.ts 六类外部证据判定 |
| 回退与冲突（精确父版本 + apply_conflict 不覆盖） | ✅ | pack.rollback 指向封存父工件；runbook §5/§6 |
| 文档与留痕 | ✅ | ADR-003、E0 基线、runbook、本报告、README |
| 未决项诚实记录 | ✅ | dsh-auto-evolve not-run（三条理由）；Token/费用硬限制标注未实现 |

## 3. 守门流水线实测（容器，2026-10-24）

```
改进候选:  decision=pass  reasons=[strict-improvement-met]
           counts 12/12/0/0；baseline 50% → candidate 100%
           security-findings=0  env-match=true（实测比对）
           capability-gaps=[]（buildManifest+probeBwrap）  验证包已导出
无改进候选: decision=reject reasons=[case-skip-detected]  counts 12/8/4
确定性:    同一候选连续复跑判定一致（nightly determinism 阶段）
```

## 4. nightly 长循环演练（E5，容器实测）

```
[nightly] PASS journal-stress:   {"appends":1000,"events":1000,"chainOk":true,"tamperDetected":true}
[nightly] PASS trial-lifecycle:  {"cycles":50,"failures":0,"fdDrift":1,"rssDeltaMb":-16,"medianMs":2305,"p95Ms":2318}
[nightly] PASS concurrency:      {"aOk":true,"bOk":true,"markers隔离正确","distinctPids":true}
[nightly] PASS determinism:      {"runs":3,"verdicts":["pass","pass","pass"]}
[nightly] overall=PASS           report=reports/runs/evolution-nightly-final/nightly-report.json
```

解读：50 次真实 bwrap 试炼子进程全成功、无 fd 泄漏（漂移 1，硬上限 10）、
RSS 无增长；journal 千次追加后 hash chain 完整且中段篡改仍被检出；并发双
试炼工作区互不串线、驱动进程独立；同一候选三次完整流水线判定一致。
CI 以缩减参数（5 循环/100 追加/1 次）复跑同一演练（ci.yml）。
稳定性验证：缩减版连跑 6 次全过；曾发现 lifecycle 循环中文件断言未防护
导致偶发崩溃——已修复为"计数 + 记录首错详情"（失败可观测不吞输出）。

## 5. 与竞品对照（同一冻结基准语义）

| 对象 | 可比性 | 结论 |
|---|---|---|
| DSH-BASE / DSH-PLUGIN | 复用 v19 矩阵（43 case × 5 subject） | 治理底座不变：DSH-PLUGIN 42/1/0；evolution 增量在其上，零回归（单测 207 全绿） |
| DSH-PLUGIN + evolution | 本报告全部实测 | 试炼链路的安全判定全部由外部证据支撑；覆盖与门禁达 v3.1 要求 |
| dsh-auto-evolve | 证据化 not-run | 上游无锁定 release（master 移动目标）；需真实模型凭据；正式对照需独立 ADR（E0 基线记录） |

## 6. 边界与后续（如实）

- Token/费用硬限制未实现（无内核机制），报告仅计量不声称 enforced；
- 真实模型 lane、Shadow Mode、E2/E3 资产、自动晋级：均按 v3.1 移出 MVP，
  开启需独立 ADR + 对应测试族（EVO-SHADOW 等）；
- 验证包的手工应用面依赖操作员纪律（runbook §4 复验步骤），无技术强制——
  这是"人工应用"路径的固有属性；
- pr-agent 工具链：评论身份与红叉语义依赖 master 的 workflow 配置
  （issue_comment 事件取默认分支），已同步并经所有者授权。

## 7. 复现

```bash
docker build -t hourglass-test -f docker/Dockerfile .
docker run --rm --privileged -v "$(pwd -W)/reports:/opt/reports" \
  hourglass-test hourglass-entrypoint run-all
# 或分项：gates / unit / evolution-smoke / evolution-coverage / evolution-nightly / compare / perf / rob04
```

## 8. MVP-B / M1 增量（ADR-004 真实试炼 lane，PR #15–#18）

ADR-004（已接受，2026-10-24）把试炼信号从「合成基准上的命令覆盖」升级
为「真实任务上的配对证据」。四 PR 交付，全部走完 评审→修复→CI 绿→合入：

| PR | 交付 | 评审轮 |
|---|---|---|
| #15 | **D2-1 LLM broker**：host 侧唯一咽喉——凭据注入/剥除、双协议（completions + Messages）、usage 计量取上游真值、fail-closed 硬上限（调用/token/墙钟/并发，含中止调用计费）、代理 CONNECT 边界硬化 | 5 轮，202 测试 per-file 100% |
| #16 | **D1-1 载体探针**：subagent-dsh-sdk 全量 DSH 子进程，P1-P4 切换前置证据全过（独立 PID、子侧隔离内容级证据、一次性生命周期零 fd 增长、候选技能仅经内容寻址快照到达模型请求） | 4 轮 |
| #17 | **D1-2 真实任务集**：六项 hourglass 开发史真实缺陷（fixture=缺陷现场最小提取、judge=当时真实回归断言、reference=真实修复），内容寻址 manifest + agent-lane.lock.json（与 shell lane 同纪律；evolution.lock.json 字节不动）+ 判别力自检（fixture 必拒、reference 必过） | 1 轮 |
| #18 | **D1/D2 合流 runner**：配对双臂试炼（baseline vs 候选技能）→ 隐藏 judge → 四态 campaign（策略 provisional）→ broker 计量进 report；mock 冒烟进 CI，真实 lane 双重 opt-in + dry-run 调用上界 + 最小子集先行 | 1 轮 |

**mock lane 全链路实测**（容器，2026-10-25）：六任务双臂全部 completed，
baseline 0% / candidate 100%（参照修复经子进程自身工具执行落地），
技能快照到达每个 candidate 请求，18 调用 / 426 token 计量入报，
campaign=`inconclusive (insufficient-samples)`——6<8 配对样本如实报不足。
载体探测回归 ok=true（P1-P4 不变）；任务自检 6/6 判别有效；单测 23 文件
296 用例、evolution 覆盖 13 文件 202 测试 per-file 100%。

**调试修复的重要缺陷**（均已实证后固化）：patch 未与 shims 同目录时
子进程**静默零治理插件装载**（技能镜头缺失暴露）；SSE CRLF 帧丢弃致
用量失计量；caps env 坏值 NaN fail-open（改拒跑）；`*.md` CRLF 检出下
技能 frontmatter 解析失败（shim CR 容忍）。

### 8.1 真实 lane 首跑与阈值重校（2026-10-25，已回填）

密钥路径与首跑步骤按 runbook §9.2 执行（`deepseek-flash` @
api.deepseek.com/anthropic，Bearer 经 broker 注入，密钥全程 host 侧）。
两跑实测：**子集首跑**（z-from-ci）双臂全过，baseline 8 调用/23,825
token/51.7s、candidate 5 调用/6,086 token/21.4s；**全量基线**（6 任务
双臂）12/12 臂 completed 且 judge 全过——**baseline 成功率 100% 天花
板**，97 调用/150,793 token/墙钟 478s，未触硬上限，recorder 零命中。
方差实测：同一任务无技能两跑 8→27 调用、23.8K→55.0K token。

重校结论（ADR-002 三原则，全文见 ADR-004 附表 A）：**agent lane 成功率
golden 维持未启用**（六任务对该模型零区分度，严格改进阈值结构性不可
满足；晋级继续走 shell lane 旧 golden），agent lane 保持数据采集模式；
成本/延迟阈值须待每任务 ≥8 配对样本；17/97 用量未知调用按
abortedCallTokenCharge fail-closed 计价并逐调用留痕。首跑证据存本地
`reports/runs/agent-lane-real-20261025T103{415,754}Z`（不入库）。

### 8.2 八轮配对基线与首个真实候选试炼（2026-10-25，ADR-004 附表 B）

10 任务（含 tranche-2 四个更难真实任务）× 双臂 × 8 轮：1,899K token /
1,059 次调用；7 轮全绿 + 1 轮调用上限 fail-closed（该轮配对按截断剔
除）。结论：①成功率天花板在 n=8（80 配对）下不动——更难任务也全被
deepseek-flash 解出；②成本维度出真信号：首个真实候选
`hourglass-fix-discipline` 判 **reject**——9/10 任务配对更贵（技能正文
的每轮提示开销未被省轮次赚回），总体配对差 +2,566 token/任务对；唯
一例外的最难任务 z-from-ci 净差 −3,950 但符号不稳定（7 对 3 正）。
跨轮方差 3–6 倍，配对设计与 n≥8 是最低要求。golden 维持未启用，细化
条件见 ADR-004 附表 B。这是 agent lane 首次以真实数据否决真实候选
（机制闭环证据），也是「候选技能不是免费的」首条实测。

### 8.3 复现（增量）

```bash
docker build -t hourglass-test -f docker/Dockerfile . --pull=false
# 零模型链路（CI 同款）
docker run --rm --privileged hourglass-test hourglass-entrypoint agent-tasks-selftest
docker run --rm --privileged hourglass-test hourglass-entrypoint agent-carrier-smoke
docker run --rm --privileged hourglass-test hourglass-entrypoint agent-lane-smoke
# 真实 lane（手动，见 runbook §9.2 密钥与省量次序）
```
