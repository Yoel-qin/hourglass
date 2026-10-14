# ADR-001: hourglass 沙箱治理插件的职责、扩展点与集成方式

- 状态：已接受（P1 范围）
- 日期：2026-10-13
- 决策人：hourglass 项目（完全自动模式会话 1）
- 计划依据：《DeepSeek-Harness-沙箱插件开发与竞品对比测试计划》§7 P1、§2 P0-A 交付物

## 背景

DeepSeek Harness（DSH，commit d743267）提供进程沙箱（bwrap/Landlock/Seatbelt/Windows ACL）
但缺少治理层：无可观测审计、无能力清单、无策略回归。测试计划要求在 DSH 之上实现
"沙箱治理插件"（审计账本 + 能力清单 + Policy CI），并与开源沙箱（SRT/Codex/nsjail）
在统一测试语义下对比。

## 决策

### 1. hourglass 是独立项目，不修改 DSH 仓库

用户指令要求项目落在 `D:\Aiproject\hourglass`（项目名 hourglass）。DSH 本地仓库
（D:\Aiproject\deepseek-harness）保持只读。集成方式：

- 测试容器内 `git clone` DSH（固定 commit d743267），把 hourglass 的包复制进 clone 的
  `packages/hourglass/`（DSH 的 pnpm-workspace 通配 `packages/*/*` 自动接纳），以
  `pnpm install --no-frozen-lockfile` 链接。
- 产品部署路径（不在本阶段实现）：profile `cordis.patch.yml` 的 `- insert:` 行挂载
  hourglass 包（DSH 外部插件的标准通道，见 dsh plugin-manager）。

**与计划的差异**：计划假设在 DSH 仓库内开发（packages/<group>/<pkg>/ + run-gates 注册）。
本实现改为独立项目 + 容器内融合，原因是用户明确要求独立目录且不动本体。版本锁校验
（validate-versions-lock.ts）作为 hourglass 自身的 gate 入口（package.json script），
不注册进 DSH 的 scripts/run-gates.ts——该文件属于 DSH 仓库，按本 ADR 不修改。

### 2. 三个包，只用现有扩展点，零 DSH 修改

| 包 | 形态 | 扩展点 | 职责 |
|---|---|---|---|
| @hourglass/sandbox-audit | 函数插件（name/Config/apply） | `tools/pre-execute`（waterfall，begin 记录）、`tools/result`（emit，end 记录）、`ctx.inject(['commands'])`（/sandbox-audit 查询） | 追加式审计账本（JSONL），拒绝分类，三层事实关联 |
| @hourglass/sandbox-capabilities | 函数插件 + 纯函数 | `ctx.inject(['commands'])`（/sandbox-capabilities） | 能力清单 manifest（5 能力 × 4 后端，证据分级） |
| @hourglass/policy-ci | 纯函数库（非插件） | 无（测试/CI 工具） | 策略语义模型 + 合成 fixture 回放 + 决策 diff |

不新增 session event type（DSH practices.md #21：老 reader 会拒开）；审计数据走独立
JSONL 账本而非 session log（计划 P1 允许，且避免与 session 格式耦合）。

### 3. 诚实性规则（编码在实现里，不是文档口号）

- `enforcement` 不是通用字段：审计只从 `result.value.sandbox`（tool-bash 契约，
  index.ts:170）或 `result.meta.sandbox` 提取后端事实；其余记 `source: 'unavailable'`。
- 纯 stderr 匹配不会升级为 `sandbox-denial` 分类（AUD-12）。
- 能力清单：`enforced` 需要 probe 或 test-result 证据；静态存在但未运行 → `unknown`。
- OS 观察层恒记 `unavailable`（P1 无内核观察器，不伪造）。

### 4. 测试环境：Docker privileged 容器

实测（2026-10-13）：Docker Desktop on WSL2 默认 seccomp 阻止 unprivileged userns
clone；`--security-opt seccomp=unconfined` 后 unshare -U 可用但 bwrap 仍失败；仅
`--privileged` 下 bwrap 完整可用。因此测试容器用 privileged，配套约束：

- 容器内不挂载宿主目录（除 reports 输出）；DSH 用固定 commit clone 进镜像
- 全部测试数据为合成 canary（DSH_SYNTHETIC_CANARY_*）
- 网络测试只连容器内本地受控服务（127.0.0.1 + /etc/hosts 合成域名）

### 5. 竞品对比框架位置

`scripts/sandbox-compare/`（hourglass 项目内）。计划的顾虑（benchmarks 语料禁令、
workspace 包图污染）在独立项目结构下自然满足：hourglass 的 scripts/ 不在 DSH
workspace 内，竞品依赖只存在于 Docker 镜像，不进任何 lockfile 的生产依赖。

## 后果

- DSH 侧零修改 → 升级 DSH commit 只需改 Dockerfile ARG 与 versions.lock.json
- 插件不能依赖 DSH 内部私有 API（如 LocalSandboxProvider.selectedRunner）——只用
  公开 seam（SandboxProvider/ConfinedArgv/tools 事件）
- Windows WFP（P2c）未立项：容器 lane 是 Linux；宿主 Windows 侧仅静态分析结论
- 薄 journal（时间旅行）默认不纳入 P1（无产品负责人批准记录，见计划 §1.3；
  决策 issue 属产品侧，工程侧按默认不实现）

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 容器内 privileged 测试边界弱于真实隔离 | 容器是一次性专用（无宿主敏感挂载）；报告明示环境等级（A 级证据仅证明该容器环境） |
| DSH workspace 融合的 install 变慢 | 镜像层缓存；hourglass 变更只重建最后几层 |
| tool-bash value.sandbox 契约变化 | audit 提取逻辑集中在 extractSandboxFacts 单点；REAL-composition 测试兜底 |
