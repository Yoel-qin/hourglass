# @hourglass/evolution-contract

自进化安全试炼场的**纯函数契约层**（v3.1 方案 §3/§4/§6 的代码化）：
候选清单校验、生命周期状态机、冻结基准 manifest、四态判定器、晋级策略与
decision digest。零运行时依赖、不执行候选代码、不接触任何沙箱或存储——
与 `@hourglass/policy-ci` 同一纪律：合成输入进、机器可读结论出。

## 模块

| 模块 | 职责 | 对应测试语义 |
|---|---|---|
| `candidate-schema.ts` | Candidate Manifest 逐字段校验；未知字段/资产类型/风险层级/能力扩张全部拒绝 | EVO-CAND-01/05 |
| `state-machine.ts` | 允许迁移表硬编码；终态无出边；不可跳过人工批准 | EVO-PROMOTE 状态语义 |
| `benchmark-manifest.ts` | 公开/隐藏/安全集划分校验；canonical-JSON hash 锁定 | EVO-BENCH-06/12 |
| `evaluator.ts` | 安全硬门禁优先 → 零跳过 → 能力/环境 → 配对严格改进 + 95% CI | EVO-BENCH 全族 |
| `promotion-policy.ts` | 仅 `pass` 可导出验证包；digest 绑定候选/父版本/基准/策略/能力/版本锁 | EVO-PROMOTE-01/02/08 |
| `hashes.ts` | SHA-256 与键序无关的 canonical JSON | 全部 hash 契约 |

判定阈值是 **MVP-A 锁定值**（ADR-003：≥2pp、95% CI 下界>0、关键类别回归
预算 0pp、成本/延迟预算 10%、最少配对样本 8、对照容差 5pp）。阈值变更必须
先改 ADR 再改代码，且旧 golden 全部失效重生成。

## 设计说明（与 v3.1 的两处落地偏差，均记录于 ADR-003）

- 校验用显式纯函数而非 schemastery：本包保持零依赖、拒绝理由完全可控；
  schemastery 出现在插件边界（`@hourglass/evolution-trial` 的 Config）。
- `versions.lock.json` 按用户指令零改动；evolution 基准的版本锁使用独立的
  `scripts/sandbox-evolution/evolution.lock.json`（E4 交付）。

## Testing hooks

全部导出均为纯函数注入点，无需真实沙箱即可全覆盖：

- `validateCandidateManifest(raw)` — 任意 JSON 进，`{ok, errors, value}` 出
- `transition(from, to)` / `canTransition(from, to)` — 状态机迁移判定
- `validateBenchmarkManifest(raw)` / `computeManifestSha256` / `verifyManifestSha256`
- `evaluate(input)` / `computeMetrics(baseline, candidate)` — 判定器与指标
- `canExportValidationPack({decision, bindings})` / `buildValidationPack(input)` /
  `verifyValidationPack(pack)` / `decisionDigest(bindings)`

测试执行（容器内，融合 DSH workspace）：

```bash
docker run --rm --privileged -v "$(pwd)/reports:/opt/reports" \
  hourglass-test hourglass-entrypoint unit        # 含本包全部 spec
# 覆盖率门禁（v3.1 §11.2，E0.6 实测固化后）：
cd /opt/dsh && pnpm exec vitest run packages/hourglass/evolution-contract \
  --config vitest.config.ts --coverage \
  --coverage.include='packages/hourglass/evolution-contract/src/**'
```

golden 基准：`tests/golden/evaluator-golden.json`（16 场景 × 四态判定，
字节冻结；重生成即新版本，禁止原地改）。
