# ADR-003: 自进化安全试炼场 MVP 范围、承载与阈值

- 状态：已接受（Evolution E0，feat/evolution-v2 分支）
- 日期：2026-10-19
- 决策人：hourglass 项目（feat/evolution-v2 会话）
- 计划依据：《DeepSeek-Harness-自进化安全试炼场-增量开发测试方案-v3.1》（仓库根）
- 前置：ADR-001（独立仓库、DSH 零修改）、ADR-002（配额阈值三原则）

## 背景

在已完成的六包沙箱治理底座（矩阵 v19，DSH-PLUGIN 42/1/0）上，按 v3.1 方案
增量开发自进化安全试炼场。用户约束：**新建 feat/evolution-v2 分支开发，
存量代码零改动；全部对比测试在本地 Docker privileged 容器执行；不合并 master。**

## 决策

### D1 可进化资产范围（MVP）

仅 `dsh_skill`（SKILL.md 内容变异）与 `prompt_fragment`（受控提示词片段，
插入位置走 DSH 中央 `getContextOrder`）。工具/Host 插件/MCP/策略/能力清单
一律 schema 拒绝；`riskTier` 只接受 E0，重新标注无效（EVO-CAND-05）。

### D2 试炼承载：一次性 trial-driver 子进程（MVP-A）+ subagent-dsh-sdk 升级路径

- **MVP-A**：trial worker = 由 runner spawn 的一次性独立子进程
  （`scripts/sandbox-evolution/driver/trial-driver.ts`，蓝本
  `dsh-plugin-driver.ts`）。治理插件（audit/net/read/rsrc）挂载在**该子进程**
  内，命令经 net→read→rsrc 装饰后交 `LocalSandboxProvider.confine()` 执行
  bwrap。子进程内不注册任何宿主出口工具（NET-13 教训：`web_fetch` 等
  harness 侧工具是独立出口，必须物理不存在而非策略拒绝）。
  满足 v3.1 §5.1 装载机制的核心要求：插件在执行面进程内装载，父进程
  （runner/evaluator）不假设其装饰器绑定子进程；隔离证据取子进程侧
  （子进程 PID + 服务端 canary 零记录）。
- **升级路径**：真实模型 lane 需要子进程内跑完整 DSH agent 时，切换到
  `subagent-dsh-sdk`（独立 DSH runtime 子进程 + 一次性 profile `- insert:`
  装载六插件）。切换前必须按 v3.1 §5.1 重新实测独立 PID/profile/子进程侧
  confine 证据，不满足则该 lane blocked。

### D3 判定阈值（MVP-A 锁定值，`MVP_A_POLICY`）

按 ADR-002 三原则（必然越限 / 不误伤 / 看门狗余量）针对合成 scripted
基准校准：

| 阈值 | 值 | 依据 |
|---|---|---|
| 首要指标 | task-contract-success（合成指令覆盖契约） | scripted adapter 下可确定性度量 |
| 最小改进 | ≥2 个百分点 | v1.0 起的锁定讨论值；合成基准单步粒度 12.5pp（8 case），2pp 足以区分真改进与噪声 |
| 置信区间 | 配对 95% CI 下界 >0（z 近似，n≥8） | n=8、全翻正时下界 ≈15pp>0；单 case 翻正下界 <0 → inconclusive（golden 场景冻结） |
| 最少配对样本 | 8 | 合成基准最小功能集规模；低于此一律 inconclusive |
| 关键类别回归预算 | 0pp | v3.1 §4.3 原文 |
| 成本/延迟预算 | 10% | 讨论起点值；仅在两侧运行均上报数据时判定 |
| 对照容差 | 5pp | 双基线对照（EVO-BENCH-01）漂移上限 |

**真实模型 lane 启用前必须重校准并更新本表**；阈值变更使全部 golden 与
既有证明失效。

### D4 资源预算

沿用 ADR-002 数值语义（wall-clock 由驱动层看门狗表达；nproc=8 配 setpriv
uid 降权；asBytes=100MB；fsizeBytes=64KB；nofile=32）。Token/费用无硬限制
机制，报告中如实标注，不声称 enforced。

### D5 晋级路径

验证包导出 + 人工批准 + 人工应用（v3.1 §6.2 唯一生产路径）。不调用
Plugin Manager、不自动改 `cordis.patch.yml`（恢复列表不含该文件、applying
不可取消、restart-required、安装触发 pnpm/lifecycle scripts——证据见
v3.1 §0.3 与 docs/evolution-plan-review.md）。

### D6 覆盖率门禁

事实：DSH `vitest.config.ts:381-389` 配有 per-file 100% 阈值，但容器
`do_unit` 不带 `--coverage`，从未对 hourglass 代码触发。处置：E0.6 先实测
`--coverage` + `--coverage.include='packages/hourglass/evolution-*/src/**'`
的触发与范围；实测结果记录于 docs/evolution/E0 基线文档；门禁固化为
`evolution-coverage` 命令在 E4 完成。既有六包保持现状，不虚假声称已覆盖。

### D7 落地偏差（相对 v3.1，均为受控偏差）

1. `evolution-contract` 校验用显式纯函数而非 schemastery：保持零依赖、
   拒绝理由可控；schemastery 仍在插件边界（evolution-trial 的 Config）使用。
2. `scripts/sandbox-compare/versions.lock.json` 零改动（用户指令）；
   evolution 基准版本锁用独立 `evolution.lock.json`（E4 交付）。
3. 状态存储 `ctx.storage.domain`（KvTable.update）在 evolution-trial（E2）
   落地；E1 契约层不引入存储。

## 后果

- 既有六包、compare 框架、docker 入口的行为与 hash 不受影响（gates 的
  versions-lock sha256 仍为 `3baf3b24…`）。
- 新包经 `COPY packages/` 整目录拷贝自动进镜像；`scripts/sandbox-evolution/`
  需在 Dockerfile 增加纯新增 COPY 行（不改既有行）。
- Shadow Mode、插件本体变异、自动晋级均不在本 ADR 范围（v3.1 §7/§6.3）。
