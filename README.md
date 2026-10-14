# hourglass

DSH（DeepSeek Harness）沙箱治理插件 + 可复现开源沙箱对比测试框架。

- **@hourglass/sandbox-audit** — 追加式结构化审计账本：每次工具调用的策略快照
  （`tools/pre-execute`）与终态分类（`tools/result`），按 `callId` 关联三层事实
  （policy_decision / backend_result / os_observation），带脱敏与只读查询命令
  `/sandbox-audit`。
- **@hourglass/sandbox-capabilities** — 强制能力清单：`fileRead` / `fileWrite` /
  `netEgress` / `resourceLimits` / `processControl` 按平台/后端分别报告
  `enforced | partial | absent | unknown`，每个状态带证据来源与引用；查询命令
  `/sandbox-capabilities`。
- **@hourglass/policy-ci** — 策略回归：合成固定 fixture + 纯函数语义模型 → 决策
  回放与 diff（allow→deny / deny→allow / to-not-replayable），CI 无网络、无模型、
  无真实会话语料。
- **scripts/sandbox-compare/** — 竞品对比框架：统一 case 语义（FS/NET/RES/AUD/ROB）、
  受控本地网络服务、逐对象 adapter（DSH-BASE / DSH-PLUGIN / SRT / nsjail / Codex）、
  版本锁与报告门禁。

设计决策见 [docs/ADR-001](docs/ADR-001-hourglass-plugin-scope.md)。

## 快速开始（Docker）

```bash
# 构建测试镜像（固定 DSH commit 与竞品版本，见 versions.lock.json）
docker build -t hourglass-test -f docker/Dockerfile .

# 运行全部测试（构建 hourglass 包 → 单测 → loader smoke → 对比矩阵）
docker run --rm --privileged \
  -v "$(pwd)/reports:/opt/reports" \
  hourglass-test /usr/local/bin/hourglass-entrypoint run-all

# 或交互式进入
docker run --rm -it --privileged hourglass-test bash
```

容器必须 `--privileged`：被测沙箱后端（bwrap/nsjail）需要创建 user/mount/pid
namespace，Docker Desktop on WSL2 对非特权容器阻止这些调用（实测 2026-10-13）。
容器是专用一次性测试环境：不挂载宿主目录（除 reports 输出），测试数据全部为
合成 canary。

## 审计语义（诚实性规则）

- **backend 事实来源**：仅当消费者在结果上真实发布了 sandbox 事实（tool-bash 的
  `result.value.sandbox` 契约）才记录；否则 `source: 'unavailable'`。绝不猜值。
- **分类信号优先级**：结构化错误码（SANDBOX_UNAVAILABLE / ABORTED / FS_SANDBOX_DENIED）
  > 消费者发布的 `denied`/`runnerFailed` > escalation 拒绝 marker。**纯 stderr 片段
  不会升级为 sandbox-denial**（只能落到 ordinary-failure/unknown）。
- **os_observation 层**：P1 恒为 `unavailable`——hourglass 不伪造内核事件。

## 能力清单规则

`enforced` 只能由 probe（真实跑过后端）或 test-result（对比矩阵用例）支撑；源码里
存在机制但未在本机运行 → `unknown`；机制不存在 → `absent`（静态判断可靠）。
`partial` 描述部分覆盖（如 windows-acl 的 WRITE_RESTRICTED 只限写）。

当前静态矩阵（源自 DSH d743267 的 profile 参数）：

| 后端 | fileWrite | fileRead | netEgress | resourceLimits | processControl |
|---|---|---|---|---|---|
| bwrap | enforced* | absent | absent | absent | partial（私有 pid ns） |
| landlock | enforced* | absent | absent | absent | absent |
| seatbelt | enforced* | absent | absent | absent | absent |
| windows-acl | partial | absent | absent | absent | absent |

\* 需探测/测试证据支撑；未运行时报告为 unknown。

## Testing hooks

按 DSH 平台包测试钩子约定（`SandboxInternals` 模式），hourglass 的可注入点：

- `@hourglass/sandbox-audit`：`classifyOutcome(signals)` 与 `extractSandboxFacts(container)`
  是导出的纯函数——单测注入合成信号即可覆盖全部分支，不需要真实沙箱。账本测试用
  临时目录驱动 `AuditLedger`（strict/非 strict、断行恢复、重启续 seq）。
- `@hourglass/sandbox-capabilities`：`buildManifest({platform, backend, probes, tested})`
  全部输入为参数——平台/后端/探测/测试证据均可注入，单一宿主即可覆盖所有平台分支；
  `probeBwrap`/`probeSeatbelt`/`probeLandlock`/`probeWindowsAcl` 是可替换的真实探测。
- `@hourglass/policy-ci`：`decide(fixture, world)` 纯函数；fixtures 全部合成固定
  （`tests/fixtures/policy-fixtures.ts`），golden 输出字节稳定。
- 对比框架 adapter：`SubjectAdapter` 接口（available/execute）可注入假实现；
  driver 以 stdin JSON 驱动，便于在任意容器中复跑。

## 仓库布局

```
packages/audit/          @hourglass/sandbox-audit（源码 + 单测 + REAL-composition loader 测试）
packages/capabilities/   @hourglass/sandbox-capabilities
packages/policy-ci/      @hourglass/policy-ci（+ golden fixtures）
scripts/sandbox-compare/ 对比框架（cases/adapters/driver/net-service/run + 版本锁 + smoke 清单）
docker/                  Dockerfile（tools→dsh→test 三阶段）+ compose + entrypoint
docs/                    ADR
reports/runs/            原始运行数据（JSON + Markdown 汇总）
```

## 已知边界（P1）

- 网络出口限制、敏感读保护（denyRead）、资源配额是 P2/P3 范围；P1 的对比矩阵会
  如实报告 DSH 在这些维度的缺口（case 判 FAIL 即暴露差距，不掩盖）。
- Codex lane 因无 OpenAI 凭证整体 not-run（原因记录在 versions.lock.json 与每条
  结果的 reason 里）——诚实缺席，不是 PASS 也不是 FAIL。
- Windows 原生 lane 不在本框架内（容器是 Linux）；SRT 的原生 Windows 路径未验证。
