# sandbox-compare — 可复现开源沙箱对比框架

统一测试语义下比较 DSH-BASE / DSH-PLUGIN / SRT / nsjail / Codex。安全用例的主判据
是**真实副作用**（文件系统快照差分 + 受控服务端收到的请求），stderr 只是辅助证据。

## 使用

```bash
node --experimental-strip-types scripts/sandbox-compare/run.ts --smoke=smoke-p1.json --out=reports/runs/<id>
node --experimental-strip-types scripts/sandbox-compare/validate-versions-lock.ts   # 版本锁 gate
```

输出：`compare.json`（全部结构化结果 + 证据）与 `summary.md`（人读汇总）。
报告引用 `versions.lock.json` 的 SHA-256。

## 被测对象与版本（2026-10-13 锁定）

| 对象 | 版本 | commit | 状态 |
|---|---|---|---|
| DSH-BASE | master | d743267388641bc76f17c45ce8b4c231aed1d32c | 容器内真实驱动 |
| DSH-PLUGIN | 同上 + hourglass | 同上 | 容器内真实驱动（含审计管线） |
| SRT | 0.0.79 | d9aac2098351ca17f3743fbaf6ecbd0051b7e00e | npm 安装，bwrap 后端 |
| NSJAIL | 3.6 | f78475530b46d0186111a9096b30725f816b55fe | 源码编译 |
| CODEX | 0.162.1 | 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d | **not-run**（无 OpenAI 凭证） |

## 适配映射（按效果对齐，不按参数名）

| 对比 profile | DSH（SandboxMode） | SRT（settings） | nsjail |
|---|---|---|---|
| P0-READONLY | `read-only` | `allowWrite: []` | `-Ro /`（全只读） |
| P1-WORKSPACE-WRITE | `workspace-write` | `allowWrite: [workspace]` | `-Ro /` + `-Rw workspace` |
| P2-DENY-READ | 无机制（如实跑 workspace-write，FS-11/12 判 FAIL 暴露缺口） | `denyRead: [.synthetic-secrets]` | 无法表达（namespace 无读白名单）→ unsupported |
| P3-NET-ALLOWLIST | 无机制（NET-02..06 判 FAIL 暴露缺口） | `allowedDomains: [allow host]`（代理强制） | 默认隔离 net ns：全断（NET-01 也断——无法表达 allowlist，如实报告） |
| P5-FAIL-CLOSED | runnerCommand 指向不存在 runner → 期望 SANDBOX_UNAVAILABLE | 不适用 | 不适用 |

语义差异明示：
- **nsjail 的网络隔离是命名空间级的**：它阻断一切出口（包括 allow 域名），因此
  NET-01（正例）对 nsjail 是真实缺口而非通过；DSH 则相反（全放行，deny 例全缺口）。
  两者都不是 allowlist 语义，只有 SRT 是。
- **DSH 的 denyRead 不存在**：FS-11/FS-12 对 DSH-BASE/DSH-PLUGIN 预期 FAIL
  （真实安全缺口），这正是对比报告要呈现的差距。
- **SRT 的 Windows 支持未在本 lane 验证**（容器是 Linux）；见 versions.lock.json。

## 环境（P0-A 侦察结论）

- 测试平台：Docker privileged 容器（node:24-slim / Debian 12），内核 WSL2 6.18。
  实测：非特权容器中 bwrap/userns 被 runtime 阻止（EPERM），仅 --privileged 可用。
- 网络测试只连容器内 127.0.0.1 受控服务（`net-service.ts`），域名经 /etc/hosts
  合成（hourglass-allow.tests.local / hourglass-deny.tests.local）。
- 所有凭据为合成 canary（DSH_SYNTHETIC_CANARY_*）；敏感文件为合成 .pem fixture。

## case 判定规则

| 证据类 | 判定 |
|---|---|
| file-must-not-exist | workspace 外快照无新增文件 → blocked pass |
| file-content-unchanged | outside 文件哈希不变 + 无删除 → blocked pass |
| no-server-request | deny host 无携带 canary 的请求记录 → blocked pass |
| error-surface（ROB-01） | 无副作用 + fail-closed 错误 surfaced → pass |
| audit-records（AUD-02/11） | ledger 中分类区分明确 / backend 事实结构化 → pass |

不通过任何 case 的 stderr 文本断言作为主判据。

## smoke 门禁

- `smoke-p1.json`：9 case（FS-02/05/06、NET-02/03/05、ROB-01、AUD-02、AUD-11）
- `smoke-p2.json`：13 case（+FS-11/12、NET-13/14——P2b 后生效）
- 零 skip 原则：planned = executed；仅显式 unsupported（带理由）可缺席，
  `blocked`（case 表缺定义）视为框架缺陷必须修复。

## 已知限制

- RES（资源限制）与 NET-13/14（Harness 代调用 / 持久 PTY）case 尚未实现，
  对应 P2/P3 交付。
- 性能基准（PERF-*）未纳入本框架首版（计划 §6 要求 30 次重复 + CI job）。
