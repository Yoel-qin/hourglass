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
