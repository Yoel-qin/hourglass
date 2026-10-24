# ADR-004: 真实试炼 lane——subagent-dsh-sdk 承载升级与真实模型边界

- 状态：**草案（讨论中）**——待维护者批准后转"已接受"并排期
- 日期：2026-10-24
- 决策人：待定（维护者）
- 前置：ADR-003（MVP 范围与承载）、evolution-v2 已发布（tag `evolution-v2`，
  验收报告 docs/evolution/final-report.md）
- 方案依据：v3.1 §5.1（subagent 承载）、§5.2（LLM broker）、§11.3（夜间/
  手动 lane）、§4.3（阈值校准）

## 背景

v2 的试炼信号是**合成基准上的命令覆盖**（directive-coverage adapter）：
候选 skill 文本决定哪些探测命令执行，判定看文件断言。这足以证明守门
机制（隔离、门禁、判定、验证包）正确，但不能证明候选在**真实任务**上
更优——那是自进化试炼场的实际目的。两个前置缺口：

1. **承载**：trial-driver 是受限 shell 子进程，不是完整 DSH agent；
   skill 的真实效果（提示词影响模型行为）无从观测。
2. **模型**：PR lane 纪律为零真实模型（零密钥/零公网）；真实评测需要
   凭据、成本与数据边界。

## 决策（草案）

### D1: 承载升级——`subagent-dsh-sdk` agent lane（MVP-B）

- 保留现有 trial-driver 为 **shell lane**（继续服务安全对抗与 nightly）；
  新增 **agent lane** driver：经 `subagent-dsh-sdk` 启动完整 DSH 子进程
  （独立 profile/session/model route/tools），治理插件以 `- insert:` 形态
  装载在**子进程的一次性 profile**（ADR-003 D2 预留路径）。
- 基准形态：skill 候选注入子进程的 skill 装载点，功能用例从"命令覆盖"
  升级为"任务契约"（给定任务输入，断言产出物/工具使用序列）；隐藏
  holdout 与安全对抗集语义不变。
- **切换前置实测（不满足则 blocked，不降级）**：
  1. 子进程独立 PID/profile 证据（进程树 + profile 目录）；
  2. 子进程侧 confine 生效证据（子进程内探测命令被拒 + 服务端 canary
     零记录）——父进程视角不算数（v3.1 §5.1）；
  3. 一次性 profile 生成/装载/清理的完整生命周期（复用 ROB-04 纪律）；
  4. 候选 skill 只经内容寻址快照进入子进程，无宿主出口工具注册。

### D2: 真实模型 lane（M1）边界

- **凭据**：LLM key 只存 Host 侧（runner 进程环境/secret），经 host 侧
  broker（复用 `@hourglass/sandbox-net` 的 unix-socket 代理模式：凭据留
  host、沙箱内无 key）投影给 agent lane；trial 子进程环境剥净密钥。
- **数据**：仅合成与脱敏输入进入 agent lane；PR gate 永远零真实模型；
  真实模型只在手动/夜间 lane（entrypoint 独立命令 + 显式 opt-in）。
- **成本**：Token 与调用数计量进入 report（现有 ExecutionCounts 扩展）；
  每日/每 run 硬上限（调用次数与墙钟可硬限；token 超限→`blocked`，按
  v3.1 不得声称 enforced 除非有硬机制）。超限行为=fail-closed。
- **阈值重校准**：真实模型方差远大于合成 adapter，MVP-A 的 2pp/8 样本
  阈值失效；按 ADR-002 三原则用真实 lane 的基线数据重算，写入本 ADR
  附表后启用（旧 golden 保留为 shell lane 基准，agent lane 用新 golden）。

### D3: 不做的事

- 不开启 Shadow Mode / E2/E3 资产 / 自动晋级（维持 v3.1 §7/§6.3）；
- agent lane 不进 PR gate（防止密钥与费用进入日常门禁）；
- 不在 agent lane 放宽安全对抗集（与 shell lane 同一套硬门禁）。

## 待决问题（需要 owner 拍板）

1. 真实模型供应商与预算上限（DeepSeek？月度额度？）；
2. agent lane 基准的任务集来源（合成任务生成器 vs 脱敏历史任务）；
3. 排期：D1（承载，估 5–8 人日）与 D2（模型边界，估 3–5 人日）是否
   同期推进。

## 后果

- 试炼信号从"机制正确性证明"升级为"真实任务表现证据"，skill 进化闭环；
- 新增密钥管理面（Host 侧）与真实费用；PR/日常纪律不变；
- 验收报告需追加 MVP-B/M1 章节（同 v3.1 §17 纪律）。
