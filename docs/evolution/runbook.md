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
