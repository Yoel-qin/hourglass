# Evolution v2 操作员手册（runbook）

> 对象：维护者/操作员。范围：自进化安全试炼场 MVP（feat/evolution-v2）。
> 依据：v3.1 方案 §6/§8 + ADR-003。本手册只描述**人工**操作面——MVP 无任何
> 自动安装/自动回滚。

## 1. 角色与不变量

| 角色 | 职责 |
|---|---|
| 提案方（人/Agent） | 准备 `SKILL.md` 或提示词片段候选文本 |
| 守门流水线 | 封存 → 试炼 → 四态判定 →（仅 pass）导出验证包 |
| 操作员（你） | 审查验证包 → 批准记录 → 手工应用 → 观察 → 必要时回退 |

不变量：候选**永远**不能自证安全；晋级**永远**需要人工批准 + 手工应用；
Plugin Manager 与活动 `cordis.patch.yml` **永不**被自动调用。

## 2. 日常命令（Docker privileged 容器）

```bash
# 守门流水线（改进候选必须 pass；阴性对照必须 reject）
docker run --rm --privileged -v "$(pwd -W)/reports:/opt/reports" \
  hourglass-test hourglass-entrypoint evolution-smoke

# 覆盖率门禁（evolution 两包 per-file 100%）
docker run --rm --privileged -v "$(pwd -W)/reports:/opt/reports" \
  hourglass-test hourglass-entrypoint evolution-coverage

# 长循环演练（journal 千次追加 + 50 次试炼生命周期 + 并发 + 判定确定性）
docker run --rm --privileged -v "$(pwd -W)/reports:/opt/reports" \
  hourglass-test hourglass-entrypoint evolution-nightly
# 可调：-e EVOLUTION_NIGHTLY_CYCLES=100 -e EVOLUTION_JOURNAL_APPENDS=2000 -e EVOLUTION_DETERMINISM_RUNS=5
```

运行产物在 `reports/runs/evolution-*/`：`report.json`（判定与证据）、
`evolution-journal.jsonl`（hash-chain 生命周期）、`nightly-report.json`、
`pack-*.json`（验证包，仅 pass 时）。

## 3. 判定结果处置

| decision | 含义 | 操作员动作 |
|---|---|---|
| `pass` | 安全硬门禁全过 + 严格改进达标 | 走 §4 验证包流程 |
| `reject` | 安全失败 / 无严格改进 / 零跳过被触发 | 阅读reasonCodes，废弃候选（内容不变重试无意义） |
| `inconclusive` | 样本不足 / CI 跨 0 / 环境不稳 | 加样本重跑（新 trialId，同一 candidate hash） |
| `blocked` | 能力/环境/版本锁不匹配 | 先修环境（常见：容器内 DSH tag 与 lock 的 dshCommit 不一致、bwrap 探测失败） |

## 4. 验证包审查与手工应用（唯一晋级路径）

1. **审包**：核对 `pack-*.json` 的 `bindings`——`decisionDigest` 可用
   `@hourglass/evolution-contract` 的 `verifyValidationPack` 复核；确认
   `artifactSha256` 与候选内容一致、`parentRevision` 指向你认可的父版本。
2. **应用前复验**（防 TOCTOU，方案 §3.3 第 7 条）：
   ```bash
   sha256sum <目标 SKILL.md 路径>   # 必须仍等于 parentRevision 内容的哈希
   ```
   不匹配 → 目标已被人工修改 → **停止**，走 §6 冲突流程。
3. **批准记录**：在 pack 的 `approval` 字段填入批准人/时间/范围（这是
   证据的一部分，口头批准不算）。
4. **手工应用**：将封存工件内容（candidate store 中 `artifacts/<sha>.txt`）
   写入目标 `SKILL.md`；写入后再次 `sha256sum` 核对等于 `artifactSha256`。
5. **留痕**：通过 journal API 记录应用事件——**绝不手工编辑
   `evolution-journal.jsonl`**（它是 hash-chain，手工行会断链并被
   `verify()` 判为篡改）。在 DSH workspace 内执行：
   ```bash
   node --experimental-strip-types -e "
     import { EvolutionJournal } from '@hourglass/evolution-trial/src/evolution-journal.ts'
     new EvolutionJournal('<journal路径>').append('manually-applied',
       { candidateId: '<候选ID>' },
       { beforeSha256: '<应用前哈希>', afterSha256: '<应用后哈希>' })
   "
   ```
   （journal 路径见流水线输出目录；append 会自动接链。）

## 5. 回退

验证包的 `rollback.parentRevision` 指向精确父版本内容（candidate store
中 baseline 工件）。回退 = 用该工件原样覆盖目标文件 + 核对哈希 + journal
记 `rolled_back`。**不**用"重新生成相似内容"代替原版本。

## 6. 冲突（apply_conflict）

应用或回退前发现目标文件哈希与预期不符：**不得覆盖**。保留现场，人工
合并三方差分（父版本 / 当前文件 / 候选），合并后作为**新候选**重新走
完整流水线。

## 7. 查询命令（DSH 会话内）

`sandbox-evolution`（注册名，无斜杠前缀）：
- 空输入：journal 摘要（链条完整性 + 最近事件）
- `{"candidateId":"cand-…"}`：候选清单 + 工件校验状态

## 8. 故障排查速查

| 症状 | 首查 |
|---|---|
| lock gate FAILED | 基准/fixture 文件与 `evolution.lock.json` 哈希不符（LF 规范化后计算）；锁改动需新版本同 PR 评审 |
| blocked: environment-fingerprint-mismatch | 容器镜像 DSH tag 与 lock 的 dshCommit；`git -C /opt/dsh tag --points-at HEAD` |
| blocked: required-capability-unavailable | `probeBwrap` 失败（非 privileged 容器？）或五能力降级 |
| driver-no-output / watchdog-timeout | trial-driver 崩溃；查 `ledger-*.jsonl` 与 driver stderr（response.error 带 500 字符） |
| pr-agent 评论身份回退 github-actions | Actions 日志 `::warning::`；App 未安装/权限不含三项/secrets 失效 |

## 9. Agent lane（ADR-004 MVP-B/M1）

承载 = 完整 DSH 子进程（subagent-dsh-sdk，一次性 profile + 治理插件
`- insert:` 于子进程内）；基准 = 真实任务集
（`evolution-runner/agent-lane/tasks/`，六项 hourglass 开发史真实缺陷，
内容寻址冻结于 `agent-lane.lock.json`）；判定 = 隐藏 judge（判定侧私有，
只有 fixture 与脱敏 prompt 进入子代理工作区）。

### 9.1 零模型命令（CI/日常，随时可跑）

```bash
# 任务集判别力自检：fixture 必须被 judge 拒、reference 必须过
docker run --rm --privileged -v "$(pwd -W)/reports:/opt/reports" \
  hourglass-test hourglass-entrypoint agent-tasks-selftest

# 载体探针：P1-P4 切换前置证据（独立 PID/子侧隔离/一次性生命周期/
# 内容寻址技能注入），mock LLM
docker run --rm --privileged -v "$(pwd -W)/reports:/opt/reports" \
  hourglass-test hourglass-entrypoint agent-carrier-smoke

# mock 试炼 lane：每任务配对双臂 + 隐藏判定 + 四态汇总 + broker 计量
# （candidate 臂 = 脚本驱动参照修复经子进程工具执行；机制证明，非计分）
docker run --rm --privileged -v "$(pwd -W)/reports:/opt/reports" \
  hourglass-test hourglass-entrypoint agent-lane-smoke
```

### 9.2 真实 lane 首跑（手动，显式 opt-in）

**密钥放置**：复制 `.secrets/deepseek.env.example` 为
`.secrets/deepseek.env`（已 gitignore），填入 `DEEPSEEK_API_KEY=sk-…`。
密钥只经 `docker run --env-file` 进入宿主侧 broker；子进程环境只有哑
密钥（broker 剥除客户端凭据后注入真实 key）。密钥不进 git、不进聊天、
不进任何报告。

**双重确认**：`--lane=real` 旗标（entrypoint 命令携带）**且** env
`HOURGLASS_AGENT_LANE_REAL=1` **且** env `DEEPSEEK_API_KEY`——缺一即拒
（实测 exit 1）。

**省量次序**（ADR-004 已决纪律）：

```bash
# ① dry-run：只打印计划臂数与调用上界，不 spawn（无需密钥）。
#    docker 自身选项（--entrypoint）必须在镜像名之前，其后才是容器命令
docker run --rm --privileged --entrypoint node hourglass-test \
  --experimental-strip-types \
  /opt/dsh/packages/hourglass/evolution-runner/agent-lane/agent-lane-runner.ts \
  --lane=real --dry-run

# ② 最小子集首跑：单任务双臂（≤16 调用上界；AGENT_LANE_TASKS 为逗号
#    分隔的任务 id 子集）
docker run --rm --privileged \
  --env-file .secrets/deepseek.env \
  -e HOURGLASS_AGENT_LANE_REAL=1 \
  -e AGENT_LANE_TASKS=z-from-ci \
  -v "$(pwd -W)/reports:/opt/reports" \
  hourglass-test hourglass-entrypoint agent-lane-real

# ③ 全量基线（六任务双臂；夜间/手动，采阈值重校数据）
docker run --rm --privileged \
  --env-file .secrets/deepseek.env \
  -e HOURGLASS_AGENT_LANE_REAL=1 \
  -v "$(pwd -W)/reports:/opt/reports" \
  hourglass-test hourglass-entrypoint agent-lane-real
```

报告落盘 `reports/runs/agent-lane-real-<UTC>/report.json`（卷挂载出容器），
含每臂 judge 结果、子进程 PID、技能到达证据、调用/token 计量与四态
campaign（策略标 `provisional`，待真实基线重校后写 ADR-004 附表）。

**硬上限**（fail-closed，env 可调但坏值拒跑）：默认 2,000,000 token /
30 分钟 / 每臂 ≤8 轮（`HOURGLASS_AGENT_LANE_MAX_TOKENS` /
`_WALL_CLOCK_MS` / `_MAX_TURNS`）。模型与上游：
`HOURGLASS_AGENT_LANE_MODEL` 默认 **`deepseek-flash`**（ADR 选定
DeepSeek-V4.1-Flash 的 **API id**——显示名直接传参会被告点 400 拒绝，
首跑实测）；`HOURGLASS_AGENT_LANE_UPSTREAM` 默认
`https://api.deepseek.com/anthropic`（Messages 协议，Bearer 经 broker
注入）。超限 broker 拒绝后续请求 → 任务 `blocked`，不静默继续。

### 9.3 故障速查（agent lane）

| 症状 | 首查 |
|---|---|
| real lane refusing（缺 env） | `HOURGLASS_AGENT_LANE_REAL=1` 与 `DEEPSEEK_API_KEY` 双确认 + `--lane=real` |
| invalid HOURGLASS_AGENT_LANE_* | 坏 env 值拒跑（fail-closed）；检查千分位逗号/单位后缀 |
| 子进程静默零治理插件 | patch 必须与 shims 同目录（`./`-相对按 patch 目录解析）；runner 已固化，自查勿改 |
| judge-result-line-missing | 子代理产物异常；`HOURGLASS_AGENT_LANE_KEEP=1` 重跑看 arms/ 工作区与 stderr 镜头 |
| broker capped（max-tokens 等） | 计量触顶 fail-closed；查 report.metering 与 caps 是否需要显式调高（夜间再跑） |
