# DeepSeek Harness 沙箱治理插件：开发与竞品对比测试计划

> **给 Code Agent 的执行任务书**  
> 目标仓库：以本机 `git remote -v` 和当前 checkout 为准；不得仅凭文档假定 GitHub owner/repository。
> 基线参考：用户提供的两份《沙箱插件可行性方案》、本次两份评审意见及当前仓库真实代码。  
> 计划日期：2026-10-13  
> **最高优先级：建立可复现、可审计的开源沙箱对比测试基线，并用测试证据指导插件设计。**

---

## 0. 给 Code Agent 的任务声明

你是负责 DeepSeek Harness（以下简称 DSH）沙箱治理插件的实现与验证的工程 Agent。请不要仅输出设计建议；按本计划先调查、建立基线，再实现能由仓库真实扩展点承载的最小可用功能，并运行测试、生成结果报告。

### 必须遵守的原则

1. **先读仓库规则与真实代码，再动手。** 至少阅读根目录 `AGENTS.md`、`docs/architecture.md`、`docs/subsystems/sandbox.md`、`packages/AGENTS.md`，并阅读当前沙箱、文件系统、subprocess、工具事件、审批、存储相关的包说明和测试。若本计划所述接口与当前代码不一致，以仓库现状为准，并在 ADR / 最终报告里写明差异。
2. **CI-first 建立竞品对比，复用现有跨平台证明，不重复造矩阵。** 先核实并沿用 `.github/workflows/sandbox.yml` 已有的 `bwrap` / `landlock` / `landlock-arm` / `seatbelt` 四个 leg 及其 run-guard；不要另建一套重复的完整平台矩阵，也不要移除它对“测试文件确实执行、没有 self-skip”的断言。该 workflow 的完整矩阵按仓库现有设计在 push 到 `master` 时运行；另增加 PR 门控的轻量竞品 smoke lane，按阶段版本运行 `smoke-p1.json` 或 `smoke-p2.json`。本机优先跑 DSH-BASE、DSH-PLUGIN 和可运行的 Codex-Windows；WSL2 是单独标记的 Linux 环境。SRT/Codex 的 Linux/macOS 路径复用既有 CI 证据链，Linux-only `nsjail` 只在 Linux lane 运行。对当前 lane 中已配置且受支持的 case，不得用 `not-run` 交差；必须执行、修复 CI，或提供可复核的 `blocked/unsupported` 证据。
3. **不得把代理环境变量当作网络隔离。** `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 注入仅是配置，必须测试移除代理变量、绕过代理、直连 IP、子进程及代理故障时是否仍被底层机制拦截。
4. **不得把策略日志当作强制隔离。** 需要区分“策略层判定”“沙箱后端报告”“真实操作系统效果”三类证据。
5. **不得虚报 `full`。** 每个平台、每种后端、每个被测能力都要以实际测试结果标记 `enforced`、`partial`、`absent` 或 `unknown`。未经测试的能力不许标为 `enforced`。
6. **不做大规模重构。** 优先使用 DSH 现有 Cordis 插件和事件扩展点；如必须改已有包或新增 seam，先确认是必要条件，控制改动范围并记录 ADR。不得擅自修改会话格式或迁移现有 `ctx.sandbox` 契约。
7. **不引入生产运行时对比依赖。** 竞品工具只用于测试环境；不能因比较测试把 srt、Codex CLI、nsjail 或 gVisor 加进 DSH 插件的生产依赖。
8. **安全测试只使用隔离测试目录、合成凭据和本地测试服务。** 不读取真实用户密钥，不向公网发送测试数据，不执行无限制 fork bomb，不破坏宿主数据。
9. **保留开发者现有工作。** 开始时检查 `git status` 和分支/commit；不要覆盖、重置或清理用户已有改动。测试不应依赖真实模型调用、真实 API key 或公网服务。
10. **每阶段交付实际证据。** 输出测试命令、环境、版本、原始 JSON/日志与结论；不能以“代码看起来正确”代替测试结果。证据分级为：A=本机真实后端/真实副作用实测，B=跨平台 CI 中的真实后端/真实副作用实测，C=静态源码分析，D=文档或注释声明。A 只证明该本机环境，不能替代其他 OS 的 B 级实测；C/D 不得单独支持 `enforced`。
11. **遵守仓库覆盖率和文档门禁。** 新增平台分支不得关闭或降低现有 per-file 100% statements/branches/functions/lines 门禁，也不得为过 CI 删除难测的安全分支。平台相关包必须提供与 `SandboxInternals` 等价的测试钩子，使单一宿主可以模拟各平台分支和探测结果，包括但不限于 `platform`、`chain`、bwrap/Landlock/Seatbelt/Windows ACL 探测、launcher/runner 参数或入口、临时目录清理失败；并在 README 单独设置 `Testing hooks`（或仓库规定的等价标题）章节，放在 `Model Experience` 章节之外。
12. **故障注入只能命中合成测试对象。** `kill runner`、生命周期循环和资源故障注入只能操作测试专用 runner、临时目录、独立进程组/Windows Job Object 及合成服务；测试必须断言宿主真实 runner、用户文件和真实服务未受影响。
13. **给 Agent 执行设置时间盒和升级规则。** 阶段超过预算上限 20%、关键阻塞持续超过 4 个工作小时，或出现任何未授权真实副作用时，停止扩张范围，保留现场与原始证据，提交 blocker/ADR 和下一步选项；不得通过删测试、降低覆盖率或把 `unknown` 改成 PASS 来“赶进度”。

## 1. 目标、威胁模型与非目标

### 1.1 产品目标

在 DSH 现有进程沙箱之上增加一组遵守 DSH 架构约定的“沙箱治理插件”，优先补齐以下能力：

- **可观测性**：逐工具调用记录策略快照、审批/拒绝判定、执行结束结果、实际可取得的后端信息和错误分类；能够查询、筛选和关联会话记录。后端 enforcement 不保证是通用工具事件字段，不可取得时必须记录 `unknown/unavailable`。
- **强制能力透明化**：把文件读取、文件写入、网络出口、资源限制、子进程约束分开报告，避免仅用一个 `full | partial` 代表所有能力。
- **敏感读保护**：先保护 DSH 自身文件工具能覆盖的路径；只有经 OS 后端验证的 Shell/子进程读取限制，才算该平台的强制保护。
- **网络出口限制**：在支持的平台实现域名 allowlist、默认拒绝和底层直连阻断；无法实现时明确报告能力缺口，不能无声地放行。
- **资源治理**：在可验证的平台对执行时间、进程数、内存/CPU 等施加真实限制；区分硬限制与仅在工具层计数的软策略。
- **竞品对比**：用统一测试语义比较 DSH 插件与当前公开可用的开源沙箱，而不仅是比较 README 的功能列表。

### 1.2 威胁模型

主要防护目标：提示词注入、恶意仓库内容、模型生成的错误/恶意命令，以及子进程在用户授权范围外访问文件、外联或耗尽资源。

本方案不是对抗已拿到宿主 root/管理员权限、内核漏洞、物理访问或已获授权应用级副作用的通用虚拟机边界。域名 allowlist 也不能证明访问某个被允许的域名没有数据外传风险；需要在报告里写明这一边界。

### 1.3 明确非目标

- MVP 不引入 Docker、microVM、Firecracker 或 gVisor 作为默认执行后端。
- MVP 不实现以 LLM 评估语义/意图的动态安全判定。
- MVP 不声称用 stat 前后扫描就能恢复任意 Shell 修改。薄 journal 不是当前已批准的产品目标；只有在产品范围决策通过后，才可考虑在 P1 对明确覆盖的 DSH 文件工具写操作做写前内容备份，不能外推到 Shell、PTY、SSH 或其他子进程。
- MVP 不使用 eBPF 承担强制拦截；eBPF 仅为后续可选研究项。
- **时间旅行范围决策（待批，默认不纳入 P1）**：原方向文档将“时间旅行 + 飞行记录器”放在核心位置；本计划把 Shell/子进程内容恢复放到 P4，是一项需要产品负责人显式确认的范围修订。P1 默认只交付审计/飞行记录器，不实现薄 journal。开工时必须创建决策 issue，Owner 为项目发起人指定并在 issue 中明确姓名的产品负责人；截止时间为 P0-A 结束、且不晚于 P1 首个实现 PR 开始前。若届时没有书面批准，默认决定为“P1 不纳入薄 journal”，不得边做边假定已批准。若批准，必须另列操作覆盖、写配额、性能和备份失败测试。Shell/PTY/SSH 恢复仍须 P4 单独设计。
- 不以“支持三平台”的口号换取安全语义不一致。每个平台报告实际能力与限制。

### 1.4 创新点落地矩阵（本次计划的强制要求）

本项目不是以“再做一个网络代理或审计插件”为创新目标。主要差异化应来自 DSH 已有的插件化架构、per-call policy、按能力拆分的 enforcement 事实与可回放的固定策略样本。真实录制会话只用于独立的人工离线影响分析，不能作为 CI Policy CI 或 benchmarks 的固定输入。下列项目必须落实为代码、测试或明确的后续决策，不得只写在设计介绍中。

| 创新/差异化方向 | 实施阶段 | 具体任务 | 验收证据 | 约束 |
|---|---|---|---|---|
| **Enforcement Capability Manifest（强制能力清单）** | P1 | 把 `fileRead`、`fileWrite`、`netEgress`、`resourceLimits`、`processControl` 等能力按平台/后端分别表示；明确能力状态、证据来源、探测时间及缺口 | 同一 profile 在不同 OS/后端输出的机器可读 manifest；单元测试 + REAL-composition + 对比报告 | `enforced` 只能由实际强制机制及有效测试支持，配置意图或 README 声明不能作为证据 |
| **基础 Policy CI（策略回归）** | P1 | 在 `packages/sandbox/sandbox-policy/tests/` 使用合成、固定、经评审的 fixture（可复用符合规则的现有 keyless sandbox fixtures）；纯本地回放旧/新策略并生成决策 diff | 合成 fixture 的 golden 测试；报告列出新增 deny、deny 变 allow、allow 变 deny、ask/unknown 与原因 | CI 不使用 recorded Sessions、用户材料、ambient repository 或网络服务；不调用真实模型、不访问公网。录制快照仅供人工触发的离线影响分析，放 `scripts/` 或包内 dev 脚本，不进入 CI 门禁 |
| **三层执行事实关联** | P1 记录 schema，P3 完成可用事件源关联 | 用稳定的 `sessionId`、`callId`、`eventId`、`policyId` 关联策略判定、后端执行结果与可取得的 OS 观察证据；每个事实带 `source` 和 `confidence/status` | 查询一次调用能够看到 policy decision、backend result、OS observation（若可用）的关联情况，缺失事实明确标 unknown/unavailable | 绝不能把 harness 的 deny 事件伪装成内核拒绝；没有 OS 观察源时不得声称具备内核 ground truth |
| **结构化拒绝事件（Out-of-Band Denial Events）** | P3 | 把策略拒绝、沙箱后端拒绝、runner 失败、普通命令失败分别记录为稳定类型事件；探索 OS 原生审计/可选观察器补充实际拒绝事实 | 事件类型测试、错误归类回归、对比报告；若存在 OS 事件，验证其与调用/进程归因关系 | 不继续依赖 stderr 文本作为唯一事实来源；stderr 可以保留为诊断信息 |
| **可选运行时内核观察** | P5 / 实验 | 先只观测，不拦截；优先评估 Linux eBPF 或其他可用的 OS 观测来源、权限门槛、发行及维护成本 | 可复现的探测报告、事件丢失/延迟/开销测量、许可证与平台矩阵 | 不阻塞 MVP；不可用时标 `unavailable`，不得因此宣称安全层失效或已获得内核事实 |
| **可复现开源沙箱对比** | P0 起持续执行 | 将 DSH-BASE、DSH-PLUGIN、SRT、Codex、nsjail 放到相同测试语义和受控 fixture 下对比；对策略级特性和 OS 强制效果分别报告 | 固定版本、配置、原始 JSON、真实副作用证据、性能分布、不可比较项说明 | 不把“某竞品不能导出内部事件”判成隔离失败；标明 observability 不可比较与 enforcement 结果 |

**P1 的 Policy CI 只要求实现最小、可重复、纯本地的策略回放闭环。** CI 门禁语料来源已拍板：`packages/sandbox/sandbox-policy/tests/` 中的合成固定 fixture；不得把 recorded Sessions / `snapshots/` 录制会话搬入 `benchmarks/` 或任何自动 CI 门禁。人工触发的真实历史调用离线影响分析另设工具，默认不在 CI 运行，并须先落实脱敏、访问授权和保留规则。竞品对比框架固定优先放在 `scripts/sandbox-compare/`：根据本次仓库勘察，`scripts/` 不在 `pnpm-workspace.yaml` 的 packages 列表中，而 `benchmarks` 是 workspace package；因此选 `scripts/` 能避开 `benchmarks/AGENTS.md` 对录制语料的禁止项，也避免把竞品依赖纳入 workspace 包图、污染根 lockfile 或触发 `check-workspace-constraints`。只有仓库政策明确要求且 `benchmarks/AGENTS.md` 允许时才考虑 benchmarks；默认不在 `benchmarks/` 新建竞品框架。竞品比较须公平地区分两类结论：一是同等外部攻击场景下的实际拦截能力，二是 DSH 独有的内部可观测性/策略回归能力。后者是产品差异，不应虚构成竞品在安全强制上失败。

## 2. 仓库侦察与前置核对（P0-A）

在实现前完成以下检查，并把结果写入 `scripts/sandbox-compare/README.md` 或适当的 Agent Note；开始时先核实该目录在当前 checkout 中尚不存在/没有冲突内容，保留既有改动：

1. 记录仓库 commit、Node/pnpm 版本、操作系统、内核版本、架构、当前工作区状态。
2. 阅读 `AGENTS.md`、`docs/architecture.md`、`docs/subsystems/sandbox.md`、`packages/AGENTS.md`。
3. 核查当前包与实现：
   - `packages/sandbox/sandbox`
   - `packages/sandbox/sandbox-local`
   - `packages/sandbox/sandbox-policy`
   - `packages/sandbox/sandbox-windows-acl`
   - 文件系统栅栏及写操作事件
   - bash、PowerShell、terminal、PTC、SSH 等 subprocess consumer
   - `tools/pre-execute`、`tools/post-execute`、`tools/result` 的实际签名与 waterfall 语义
   - `ctx.approval`、`ctx.storage`、`storage-sqlite` 和 session log 现有能力
   - 真实 CI / e2e / coverage / snapshot / REAL-composition 规则
4. 查明现有测试覆盖了哪些路径，尤其持久终端、PTC、SSH 与 Windows 的边界。不能假设某个工具事件就覆盖全部子进程。
5. 检查现有安全报告与文档中 `full | partial` 的实际定义，避免新旧语义冲突。
6. 先执行现有、成本可接受的基线检查，保存命令及结果；不得先修改代码再记录基线。
7. 通过真实 Loader / `cordis.yml` 组合方式确认新插件能装配；产品可见插件不能只靠手工 `ctx.plugin(...)` 单元测试证明正确。
8. 形成 Harness 进程、Harness web fetch/MCP 工具和受约束 shell/terminal/PTY/SSH 子进程的网络信任边界图；列出每条出网路径的策略归属、审计来源和绕过用例。
9. 勘察并复用 `.github/workflows/sandbox.yml` 的四个现有跨平台 leg 和 run-guard；确认它有意只在 push `master` 时跑完整矩阵，不能把 PR 触发要求错误地套到该 workflow 上。设计 PR 专用轻量 smoke lane，不重复创建完整跨平台矩阵。
10. P0 Windows WFP spike 必须回答三个独立问题：所需管理员权限/服务/原生代码是什么；在自托管共享 runner 上改 WFP 是否会污染并行 job 或切断 runner 自身网络；是否必须提供专用隔离、最好临时/可回收的 runner/VM。仅证明“有管理员权限”不算 spike 通过。
11. 固化 PR smoke、master 完整矩阵、夜间/发布测试三档选择，建立阶段化 `smoke-p1.json` / `smoke-p2.json` 和版本锁校验门禁；定义时间盒、超过预算/阻塞时的升级模板。

### P0-A 交付物

- 当前 DSH 沙箱能力清单与代码位置。
- 现有测试/CI 命令清单，尤其 per-file 100% 覆盖率、doc-sync、README 双语/目录生成和 REAL-composition 门禁。
- 实际工具执行路径清单（每条路径说明经哪些 sandbox/事件/文件工具）。
- `scripts/sandbox-compare/versions.lock.json` 初版：DSH commit、竞品 tag/commit、安装/构建信息、OS/内核/架构、实际配置及锁定的 CI action/runtime 版本；报告必须引用该文件 SHA-256。新增 `scripts/sandbox-compare/validate-versions-lock.ts`，并在 `scripts/run-gates.ts` 中注册版本锁校验 gate，校验必需字段、固定 commit/action 引用、未支持项的明确原因、版本更新审阅信息；结果报告必须校验其 `versionsLockSha256` 与文件实际 hash 一致。
- Windows WFP 权限与隔离 spike 结论：明确管理员权限、服务/原生组件和安装/卸载要求；验证更改 WFP 是否可能污染共享 self-hosted runner 的其他 job 或切断 runner 自身连接；决定是否必须使用专用隔离 runner/临时 VM。未有隔离保证前，禁止在共享 runner 上修改防火墙规则。另明确现有 Windows ACL 的 WRITE_RESTRICTED 机制对读限制的边界，不能把它当作 denyRead 已实现。
- `ADR-001`：新插件的职责、扩展点、需不需要改现有包、兼容性影响。
- 新增平台测试包的 `*Internals`/等价测试钩子设计约定。

## 3. 竞品与对比范围（P0-B，核心交付）

### 3.1 必测对比对象

| ID | 被测对象 | 定位 | 在比较中的作用 | 必须固定的版本信息 |
|---|---|---|---|---|
| DSH-BASE | 当前 DSH 沙箱，不加载新插件 | 现有基线 | 确认目前实际保护能力及开销 | DSH commit、后端、系统信息 |
| DSH-PLUGIN | 新插件与现有沙箱组合 | 本次实现 | 目标对象 | DSH commit、插件配置/commit |
| SRT | [`anthropics/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) | 最接近的进程级文件/网络沙箱参考 | 第一竞品 | 发布 tag + commit SHA + 安装方式 |
| CODEX | [`openai/codex`](https://github.com/openai/codex) 的可用 sandbox 路径 | 主流 Agent 沙箱参考 | 第二竞品 | release/commit SHA + CLI 版本 + 实际命令 |
| NSJAIL | [`google/nsjail`](https://github.com/google/nsjail) | Linux namespace / seccomp / 资源限制参考 | Linux 强隔离参考 | release/commit SHA + build flags + kernel |

### 3.2 可选探索对象

- **gVisor (`runsc`)**：只作为 Linux 重隔离/性能上界的探索项。其架构与本地 OS 原语沙箱不同，不纳入 DSH/SRT/Codex 的默认一对一分数排名。
- **原始 bubblewrap**：可选，用于分解 Linux 后端自身成本，不把它当完整 Agent 沙箱竞品。

### 3.3 版本与事实核验要求

外部项目发展很快，实施当日必须从上游仓库获取当前 tag/commit，不能照抄本计划中的版本。保存：项目 URL、license、tag、commit SHA、下载/安装命令、平台支持、被测配置、文档日期，并锁入 `scripts/sandbox-compare/versions.lock.json`。所有报告必须引用该锁文件及其 SHA-256；只在报告正文手写版本号不算完成。锁文件更新需要审阅，避免在同一次 PR 内静默漂移竞品版本和测试结果。以本机 `git remote -v` 核实实际 GitHub owner/repository；不要从示例 URL 推断仓库归属。

重点核实 Anthropic Sandbox Runtime 的当前真实行为，而不是只信 README。**原生 Windows 的 SRT lane 预期基线是 `unsupported`**：按本次评审的现有调研，SRT 的原生沙箱路径针对 macOS/Linux，不能为原生 Windows 命令经 SRT 受限安排实施预算；Windows 侧只把 WSL2 当作独立 Linux lane。P0 仍须以锁定版本的上游源码/文档确认这一点并留证；若该版本确实发生变化，提交版本更新证据后再调整。对 Codex 与 nsjail 也遵循同一原则。

竞品缺少某项能力时标记为 `unsupported`；测试工具不能运行时标记为 `not-run` 并写原因；环境/权限导致不能确定时标记为 `unknown`。三者均不等价于 PASS 或 FAIL。

## 4. 公平对比测试框架设计（P0-C）

### 4.1 测试框架职责

采用 CI-first 的可复现对比框架，固定使用 `scripts/sandbox-compare/`（除非仓库规则检查证明不可用并经 ADR 批准替代路径）。依据当前 workspace 结构，`scripts/` 不属于 pnpm workspace packages，而 `benchmarks` 属于 workspace package，因此该路径既避开 recorded Sessions 的 benchmarks 语料禁令，也避免竞品依赖进入 workspace 包图、根 lockfile 和 `check-workspace-constraints`。先检查根目录、`scripts/` 与 `benchmarks/` 的 `AGENTS.md`，任何录制会话、真实用户材料、ambient repository 或网络依赖都不得进入 benchmarks fixture 或 CI Policy CI。框架应有：

- **统一场景规范**：每个测试用例有固定 ID、前置条件、输入、期望状态、实际证据、清理步骤。
- **版本锁与报告门禁**：固定文件为 `scripts/sandbox-compare/versions.lock.json`；提供 `scripts/sandbox-compare/validate-versions-lock.ts`，由 `scripts/run-gates.ts` 调用。至少校验 JSON/schema、DSH commit、竞品 tag/commit 或明确的 `unsupported` 原因、OS/runtime/CI action 固定版本、更新审阅信息；报告必须带锁文件 SHA-256，CI 校验它与实文件一致。分支名/latest/tag 若可漂移，必须同时锁定解析出的 commit SHA。
- **每个沙箱一个 adapter**：DSH、SRT、Codex、nsjail 分别封装启动/策略参数，不改写被测工具内部代码。
- **统一输出格式**：保存结构化 JSON，至少包含 `runId`、时间、host、OS/kernel、架构、工具版本、policy profile、caseId、exit code、stdout/stderr 摘要、耗时、观察到的文件/网络副作用、预期/实际结果和状态。
- **证据采集器**：通过测试文件哈希、权限/目录检查、测试网络服务端请求记录、子进程状态、可用的系统调用/OS 事件，判定真实副作用，而不是仅 grep stderr。
- **可重复执行**：每次 case 使用全新临时 workspace 与独立合成秘密；测试结束清理，输出原始数据和汇总。
- **复用现有完整矩阵**：在 P0 核实 `.github/workflows/sandbox.yml` 的 `bwrap` / `landlock` / `landlock-arm` / `seatbelt` 四个 leg，复用该 workflow 作为 master push 上的完整跨平台/内核证据，不新建重复矩阵；沿用其 run-guard，确保每个 leg 的 e2e 文件真实执行且没有 self-skip（以该 workflow 当前的“Test Files 2 passed (2)”一类明确断言为参考，实际以仓库现状为准）。该 workflow 的 master-only trigger 按现有 CI 设计保留，除非 CI owner 批准修改。
- **新增 PR 轻量 gate，而非搬动完整矩阵**：增加竞品对比 PR smoke lane，只运行当前阶段指定的 `smoke-p1.json` 或 `smoke-p2.json`；显式验证指定 case 数量等于实际执行数，不能被 runner 缺失的 self-skip 伪装成通过。完整四-leg 和全面竞品比较继续在 master 的现有 workflow/对应 master job 执行。
- **可部分运行但不得隐藏 CI 缺口**：支持按 OS、沙箱、测试类别、case ID 过滤；开发者本地可跳过未安装竞品，但在某 CI lane 声称覆盖的已配置 case 必须执行，不允许用 `not-run` 代替执行。确实无法执行时记录 `blocked/unsupported`、原因和证据；阻塞项必须让 gate 明确失败/阻塞，而非默默绿灯。
- **可审阅的适配映射**：对每个竞品记录如何映射到相当的文件权限、网络策略和资源预算。不要因为所有工具参数名称不同就假定安全语义相同。

### 4.2 对比时采用的统一 profile

尽可能按“效果”对齐，不按模式名称对齐：

- **P0-READONLY**：测试 workspace 只读；明确另测工作区外的敏感文件读取，不把“禁止写入”误认为“禁止读取”。
- **P1-WORKSPACE-WRITE**：仅允许测试 workspace 写入；workspace 外的写、删、rename 应被拒绝。
- **P2-DENY-READ**：拒绝访问合成敏感目录/文件，同时保持正常工作区读取可用。若某竞品不能表达该策略，标记 `unsupported`。
- **P3-NET-ALLOWLIST**：只允许访问测试网络中的 allowlist 域名，拒绝其他域名与直连路径。
- **P4-RESOURCE-LIMITS**：对有对应能力的后端设置相同的执行时间、进程数、内存/CPU限制；无法对齐的资源维度拆开记录。
- **P5-FAIL-CLOSED**：代理/runner 缺失、启动失败、配置非法时，不得无声地按无沙箱方式执行。

`danger-full-access` 不是只有性能含义的对照项，必须作为独立安全语义路径测试：新插件不得在该模式下静默改变既有 DSH 语义；审计需明确记录该模式被使用；新治理功能应按既定契约明确是继续生效、被用户明确禁用，还是不适用，不能暗中强加或暗中绕过。此模式下测试“行为语义无意外变化”和“审计披露完整”，但不能将其结果用于证明安全隔离通过。所有竞品比较都必须报告实际生效配置。

### 4.3 测试环境要求

- 网络测试默认只连**本地受控测试服务**，使用独立测试网段或明确隔离的网络 fixture，不访问公网、不向外发送任何实际凭据。
- 采用固定合成标记，例如 `DSH_SYNTHETIC_CANARY_9f3c...`；不得读取 `~/.ssh`、真实云凭据、真实 `.env` 内容。只创建同名/同结构的测试夹具。
- 受限资源测试必须由外层 watchdog 控制，设置硬超时、最大子进程数和清理程序。禁止在宿主上运行无限制 fork bomb 或无限写磁盘测试。
- Linux/macOS/Windows 分别记录所需权限、内核/系统版本、容器/CI 限制和测试跳过原因。Windows WFP 的管理员权限、服务/原生组件和 CI 可用性必须在 P0 spike 得出明确结论；共享 self-hosted runner 上不得做可能污染其他 job 的 WFP 修改。若需管理员权限或会改动主机防火墙，必须在专用隔离 runner/临时 VM 上运行并验证恢复和 runner 联网；未做到时不得启动破坏性测试，更不能标成普通 `not-run`。
- 所有故障注入使用合成 runner 与临时目录；在每个 ROB 故障用例前后核验宿主真实 runner 的 PID/状态和真实工作区 sentinel 未变化。测试进程只能杀死由该用例启动并标记的进程组/Job Object。

## 5. 必做对比测试矩阵

P0-B1 阶段先在 DSH-BASE 上建立可复现基线；插件落地后，每条适用用例至少在 DSH-BASE 与 DSH-PLUGIN 上运行。竞品按经核实的平台能力和 CI lane 执行。安全用例以“是否产生禁止的真实副作用”作为主判据，stderr 只作为辅助证据。

### 5.1 文件系统访问边界

| ID | 用例 | 预期行为 / 证据 |
|---|---|---|
| FS-01 | 在允许的 workspace 内创建、读取、修改文件 | 按当前 profile 的允许行为成功；哈希与日志可核对 |
| FS-02 | 向 workspace 外新建文件 | 真实文件不得出现或内容不得变化；保留后端拒绝证据 |
| FS-03 | 覆盖 workspace 外已有文件 | 原文件哈希不变 |
| FS-04 | 删除/rename workspace 外文件 | 原文件仍存在且内容不变 |
| FS-05 | 使用 `../` 路径穿越 | 不得越界读写 |
| FS-06 | workspace 内软链接指向 workspace 外 | 检查读、写、删除分别是否被拒绝 |
| FS-07 | 硬链接、大小写别名、Windows 8.3 路径 | 支持的平台执行测试；未覆盖需明确 `partial/unknown` |
| FS-08 | 通过父目录 rename/delete 影响拒绝路径 | 不能只测直接打开路径，必须验证父目录操作 |
| FS-09 | 由子进程、不同解释器和持久终端执行文件操作 | 验证沙箱是否沿进程树生效；记录未覆盖路径 |
| FS-10 | `read-only` 模式下从 workspace 读取正常文件 | 应成功，避免只验证拒绝而忽略正常工作流 |
| FS-11 | 读取合成敏感文件（home 凭据目录/`.env`/`.pem` 夹具） | denyRead profile 下读取内容不可获得；区分 DSH 文件工具与任意 OS 子进程的真实边界 |
| FS-12 | symlink/hardlink 指向合成敏感文件 | 检查别名绕过，保存文件内容是否可读的证据 |

### 5.2 网络出口控制（本项目最重要的安全对比）

测试服务至少提供一个 allowlist endpoint 和一个 denylist endpoint，并记录收到的连接、路径、请求头与测试用 canary 标记。整个环境不依赖公网。

| ID | 用例 | 预期行为 / 证据 |
|---|---|---|
| NET-01 | 请求允许域名 | 连接成功，测试服务收到请求 |
| NET-02 | 请求未授权域名 | 连接失败，服务端无对应请求记录 |
| NET-03 | 将代理环境变量清空/覆盖后直接连接 | 未授权连接仍不得抵达服务端 |
| NET-04 | 对未授权服务直接使用 IP 地址 | 不得绕过域名白名单；服务端无请求记录 |
| NET-05 | 使用 Node 原生 `net`/`tls` 或其他不读取代理变量的客户端连接 | 若产品声称内核/OS 级出网强制，必须被阻止；否则应标记 `partial`，不能 PASS |
| NET-06 | 启动子进程，由子进程发起连接 | 必须继承同样的网络约束，或明确界定不支持范围 |
| NET-07 | IPv4、IPv6、不同端口与 localhost/loopback 路径 | 逐项记录规则与实际连接；避免仅测试 curl HTTPS |
| NET-08 | 代理进程停止、端口不可用或租约释放后继续请求 | 不能静默直连；输出结构化 `unavailable/denied` 证据 |
| NET-09 | DNS/DoH 与域名规范化 | 未授权目标拒绝；测试大小写、尾点、子域后缀边界、userinfo、NUL/控制字符、IDN 混淆等策略输入。非法主机名输入应拒绝，而不是被宽松匹配 |
| NET-10 | 反向测试：不配置 allowlist 或 allowlist 为空 | 默认拒绝网络，不得隐式变成允许全部 |
| NET-11 | 多会话并发使用不同 allowlist | session A 的放行不能影响 session B；租约/连接不得串用 |
| NET-12 | WebSocket/非 HTTP 协议、原始 TCP、Unix socket（按产品声称的范围） | 记录哪些协议受控、哪些不受控；不能以 HTTP 代理通过替代全网络通过 |
| NET-13 | Harness 工具流量与受限子进程的边界：会话内尝试经 web fetch、MCP 或其他 Harness 代调用访问 deny endpoint | 分别记录 Harness 控制面/模型适配器、Harness 工具自身和沙箱子进程的出网边界；不得误伤必要的 Harness 控制流量，也不得因“Harness 代 fetch”形成未审计的 allowlist 旁路；所有允许/拒绝由明确策略和审计证据支持 |
| NET-14 | 持久 PTY/terminal 与网络策略的交互，包括策略变更、代理/namespace 初始化时点、已启动 PTY 的后续请求 | 明确 `confine()`/网络隔离在哪个生命周期点生效；不得把“新 shell 会受限”外推为“既有 PTY 一定受限”；对不支持动态变更的路径明确标注并验证不会静默越权 |

### 5.3 资源限制与取消

| ID | 用例 | 预期行为 / 证据 |
|---|---|---|
| RES-01 | 墙钟超时 | 限时内结束；所有后代进程均退出 |
| RES-02 | CPU 密集测试任务 | 若声称 CPU 限额，实测限制有效；否则只记为不支持 |
| RES-03 | 受限内存分配 | 不得拖垮测试宿主；记录是否由后端硬限制、系统 OOM 或工具层超时终止 |
| RES-04 | 有上限的子进程扩张测试 | 不允许越过已配置的最大进程数；使用 watchdog，不执行无限 fork bomb |
| RES-05 | 受限文件写入量 | 达上限后无法继续产生超额副作用；分别说明“计数告警”和“硬性磁盘配额” |
| RES-06 | 打开文件描述符/句柄达到限制 | 达到后应返回可解释失败，进程与宿主仍可清理 |
| RES-07 | 用户取消/SIGINT/AbortSignal | 进程树、代理租约、临时目录及句柄按契约收敛 |
| RES-08 | 多会话并发 | 一会话的配额不得误伤另一会话；资源计数无串线 |

### 5.4 审计与可观测性

| ID | 用例 | 预期行为 / 证据 |
|---|---|---|
| AUD-01 | 成功调用 | 有调用前记录及终局记录，可用 session/call ID 查询 |
| AUD-02 | 策略拒绝/审批拒绝/执行失败 | 结构化区分 policy deny、sandbox denial、runner failure、普通命令失败 |
| AUD-03 | 配置/后端启动失败 | 可查询到失败与 enforcement 状态；不误报为安全拦截 |
| AUD-04 | 命令中含合成 token、密码参数或敏感环境变量名 | 默认审计输出脱敏；不写入真实 secret/完整环境变量 |
| AUD-05 | 并发会话 | 记录不交叉，查询过滤正确 |
| AUD-06 | 记录落盘失败 | 按声明的 `strict`/非 `strict` 策略行为运行；不得因此把沙箱安全策略改成 fail-open |
| AUD-07 | 审计查询分页/时间范围/工具名/结果筛选 | 结果稳定、上限明确，不扫描/返回无限大日志 |
| AUD-08 | 持久化重启与 schema 升级 | 重启后数据完整；迁移遵守现有 SQLite `SCHEMA_VERSION` 约定 |
| AUD-09 | 审计完整性 | 若 MVP 提供 hash chain，篡改记录必须检测失败；未提供则标记为后续能力，不假称防篡改 |
| AUD-10 | 三层事实关联 | 按 `sessionId/callId/eventId` 关联策略决策、后端结果和可用 OS 观察；不具备的层标 `unknown/unavailable` |
| AUD-11 | 拒绝事件来源 | 分别触发 policy deny、sandbox/backend denial、runner failure、普通命令失败，验证事件类型不混淆 |
| AUD-12 | 拒绝事件的原始证据 | 保存结构化错误码、后端事实与 stderr 诊断；验证仅有 stderr 匹配不会被标成权威 OS denial |
| AUD-13 | 能力清单可信度 | 对没有实际强制机制或真实后端测试证据的维度，不能输出 `enforced` |
| AUD-14 | 敏感数据与关联脱敏 | 关联事件后查询仍需脱敏，不得因 join 把原始命令、合成 canary 或环境变量泄露到默认输出 |
| AUD-15 | `danger-full-access` 路径的模式审计与语义兼容 | 审计记录该模式被使用；插件不静默修改既有语义；结果不得作为安全隔离通过证据 |

### 5.5 Policy CI（P1 最小闭环，CI 与离线语料严格分离）

**CI 门禁位置与语料来源已明确：** 测试放在 `packages/sandbox/sandbox-policy/tests/`，输入是合成、固定、经评审的 fixture；优先复用仓库已有且符合要求的 keyless sandbox fixture（例如现有平台能力 fixture），不要将 recorded Sessions 或 `snapshots/` 录制会话作为自动化测试输入。`benchmarks/AGENTS.md` 的固定输入规则优先于本计划的目录建议。

**离线历史影响分析**另用 `scripts/` 或包内 dev 脚本，人工触发、默认不进 CI；在接入 `snapshots/` 录制语料前必须评审隐私/脱敏、访问权限、保留期限与可重放字段。离线结果不作为每次提交的 CI 门禁，不能与合成 golden 报告混为一谈。

| ID | 用例 | 预期行为 / 证据 |
|---|---|---|
| POL-01 | 固定合成 keyless fixture 重复回放同一策略 | 多次输出完全确定；差异只能来自明确声明的环境维度 |
| POL-02 | 旧策略与新策略差异 | 输出 allow→deny、deny→allow、ask/unknown 变化及对应 `caseId`/工具元数据 |
| POL-03 | 新增 denyRead 规则 | 合成 fixture 的回放结果能识别受影响的调用；不得读取真实敏感文件 |
| POL-04 | 新增/修改网络 allowlist 规则 | 对纯策略判定生成差异；OS 网络实际强制仍必须由 NET-* 真实后端用例单独验证 |
| POL-05 | 不可重放/字段缺失的合成记录 | 明确标 `not-replayable/unknown`，不能默认判为 allow 或 PASS |
| POL-06 | 竞品比较边界 | 对竞品仅当其暴露可映射策略时才做策略 replay 比较；否则报告 `unsupported/not-observable`，继续运行统一黑盒攻击场景 |
| POL-07 | CI 使用约束 | 不请求真实模型、不使用 token、不访问公网、不读 recorded Sessions/user material/ambient repository；固定 fixture、固定版本的 golden 报告可在 CI 重现 |

**阶段化 smoke 列表（以 JSON 为唯一来源）**：在 `scripts/sandbox-compare/smoke-p1.json` 固化 P1 的 9 个高价值用例：`FS-02`、`FS-05`、`FS-06`、`NET-02`、`NET-03`、`NET-05`、`ROB-01`、`AUD-02`、`AUD-11`。P2b denyRead 成为核心能力后，`scripts/sandbox-compare/smoke-p2.json` 必须使用这 9 个用例并增加 `FS-11`、`FS-12`、`NET-13`、`NET-14`，共 13 个 case：分别覆盖敏感文件读取、链接/别名绕过、Harness 代调用和持久 PTY 网络边界。因为 P2a 在 P2b 前分段交付，若 P2b 开始时 P2a 任一用例仍未交付，P2 smoke gate 必须将该用例列为明确阻塞并阻止该功能阶段放行，不能静默移出清单。每次 CI 结果须记录 smoke 文件名、版本/哈希、计划 case 数和实际执行 case 数；零 skip 是 gate。只有明确配置为不适用的平台用例可标 `unsupported`，必须带理由，不能从执行数中静默消失。

### 5.6 故障关闭、逃逸与生命周期

| ID | 用例 | 预期行为 / 证据 |
|---|---|---|
| ROB-01 | sandbox runner 不存在或功能探测失败 | 按现有 fail-closed 契约报错，不能静默 passthrough |
| ROB-02 | 网络 provider/代理初始化失败 | 对需要受限网络的执行拒绝或显式报告策略降级；不能裸奔直连 |
| ROB-03 | 配置非法、域名列表空值/非法值 | 启动时报明确信息，采用保守默认，不猜测用户意图 |
| ROB-04 | 重复启动/退出至少 1000 次 | 无持续 fd、进程、端口、临时目录泄漏 |
| ROB-05 | 执行中取消、宿主子进程意外退出 | dispose 完整清理，在途请求可收敛 |
| ROB-06 | 并发 plugin load/unload / provider 重复注册 | 符合 Cordis 注册约束，不能产生两个网络 provider 互相覆盖 |
| ROB-07 | shell、pwsh、terminal、PTC、SSH 等所有已存在路径 | 逐条说明被测与未被测入口；新插件不得对覆盖范围作未经测试的承诺 |
| ROB-08 | 故障注入隔离边界：杀死合成 runner、注入清理失败、重复启动/退出 | 只作用于本用例启动的合成 runner/临时目录；断言宿主真实 runner、真实工作区和非测试服务没有被终止或修改；若无法证明范围隔离，用例不得执行破坏性动作 |
| ROB-09 | 平台分支测试钩子与门禁 | 通过 `*Internals`/等价钩子模拟平台、平台链、能力探测、launcher/runner 及清理失败；所有平台分支由测试覆盖，不修改/关闭 100% 覆盖率门禁 |
| ROB-10 | （仅获批准启用薄 journal 时）写前备份落盘失败 | 在合成存储中注入备份写入/flush 失败；已承诺可恢复的破坏性操作必须在产生副作用前失败关闭，原目标内容保持不变；记录失败类别与审计事件 |

## 6. 性能对比方法

性能与安全结果分开报告，不得将高性能抵销安全失败。

### 6.1 基准用例

- `PERF-01` 无操作/短命令启动与结束延迟。
- `PERF-02` 小文件读写、workspace 内常见编译/测试命令的执行耗时。若经批准实现薄 journal，必须将“不含 journal 的基线”与“启用写前备份后的结果”成对比较，并单独报告备份写入、哈希/复制和恢复成本，不能把系统性增加的备份 I/O 混入普通 DSH 插件开销后省略。
- `PERF-03` 含 1k / 10k / 50k 文件的测试 workspace；只有实现了文件扫描/journal 时才测试其扫描成本。
- `PERF-04` 网络 allowlist 成功连接的首次连接及稳态延迟。
- `PERF-05` 审计单条写入、批量写入、查询吞吐与数据库体积增长。
- `PERF-06` 空闲/峰值 RSS、CPU 时间、子进程和 fd 数量。

### 6.2 测量规程

1. 所有工具在相同主机、同样电源/资源条件、同一合成测试语料下运行；记录系统与版本完整信息。
2. 冷启动与热启动分开；正式性能 CI job 中每个可重复用例至少运行 30 次，资源/长时间场景按实际成本定义次数。30 次重复不能要求 Agent 在单次交互会话中同步等待，必须封装为可重跑的 CI job/命令并保存原始样本。每次提交只运行快速 smoke；合并/定期/发布工作流再运行完整重复集。
3. 报告 median、p95、最小/最大值；必要时给出置信区间，不只报告单次最好成绩。
4. 同时记录裸进程基线、DSH-BASE、DSH-PLUGIN 与各竞品，以 `overhead = sandboxed - native baseline`、`relative overhead = sandboxed / native baseline` 计算开销。
5. 随机化被测工具执行顺序或采用交替配对顺序，降低热缓存和机器状态偏差。
6. 不使用固定数字作为“竞品事实”。验收阈值先在 P0 采集基线，再在 ADR 中确定；阈值调整必须写明原因。

### 6.3 初步性能目标（待 P0 数据校准）

- 工具策略钩子附加开销：目标 p95 ≤ 5 ms。
- 审计批量入账：目标摊销每条 ≤ 1 ms；若 SQLite 配置不满足，报告瓶颈后再调批量/同步策略。
- 短命令的 DSH 插件相对 DSH-BASE 开销应有明确上限；该上限必须在真实基准后定稿。
- 不允许通过关闭安全控制、跳过审计安全事件或 fail-open 换取性能。

## 7. 插件架构与功能分阶段实施

### P1：审计账本 + 能力清单 + Policy CI（薄 journal 只有在前置决策获批后另行纳入）

**目的：** 先让 DSH 能回答“做了什么、基于什么策略、实际隔离到了什么程度”。

建议评估的包（最终命名以仓库命名规则为准）：

- `sandbox-audit`：追加式结构化审计和查询。
- `sandbox-capabilities`：若确实需要跨 provider/consumer 共享运行时能力，则定义能力清单契约；如果只有一个消费者，先用纯类型/helper，避免创建没有实际意义的新 seam。

要求：

1. 通过实际可用的 `tools/pre-execute` / `tools/result` 等事件记录调用前和终态信息；确认 waterfall 的继续/拒绝/异常语义后再接线。
2. 记录 `sessionId`、`callId`、`tool`、时间、策略快照、审批/拒绝类别，以及**实际能从当前事件/结果读取到的字段**。不得将 `enforcement` 当作通用工具层字段：当前 `ToolErrorInfo` 不包含该字段，`tools/result` 也不能保证通用取得 enforcement。仅在消费者结果实际提供 `result.sandbox.mode`、`result.sandbox.denied` 或其他已证实字段时，按来源记录；目前这些信息可能只由 bash-sandbox / pwsh-sandbox 等消费者提供。对 fs 工具和其他消费者不可观测的 enforcement 一律记为 `unknown`，并标明 `source=unavailable`，不得用默认值推断。

**后置独立 ADR：** 如需扩展 `ToolErrorInfo` 或通用事件契约承载结构化拒绝原因/enforcement，先做兼容性、消费者影响和版本治理 ADR；不在 P1 悄悄修改既有契约，也不把该扩展作为 P1 的前置条件。

3. **薄 journal 不属于 P1 默认范围。** 只有产品负责人在决策 issue/ADR 中批准后，才可追加独立 PR，在 DSH 自有 fs 工具写入口增加写前内容备份，至少覆盖新建（记录操作前目标不存在）、覆写/截断、删除、rename/移动和可支持的链接操作；记录 `sessionId/callId/path/hash/operation/backupRef`，实际字段依仓库契约确定。还必须明确备份数据是否计入 `RES-05` 的写入配额（默认建议计入，除非有可验证且对用户透明的独立备份配额设计）、性能开销基线，以及 `ROB-10` 备份落盘失败时的 fail-closed 语义。备份写入/持久化失败时，不得继续执行一个已承诺可恢复的破坏性写操作；不能被精确捕获的操作要拒绝承诺或明确标 unsupported。该 journal 不覆盖 Shell/PTY/SSH 子进程副作用。
4. 默认保存参数摘要或脱敏摘要，不默认保存完整命令、环境变量、prompt 或文件内容。记录策略版本/配置摘要，允许关联 SessionEvent。
5. 尽量通过 `ctx.storage` 与已有 storage provider 存储；避免另起一套与 session log 重叠的对话历史。若选择 SQLite，复用现有 `storage-sqlite` 装配约定和 schema 迁移方式。
6. 提供只读人类查询命令（例如 `/sandbox audit`），范围、分页和输出格式须符合现有命令规范。模型可见的审计查询工具可以后置，不是 MVP 必须项。
7. 审计失败策略必须与安全强制策略分离。非 strict 模式允许业务审计告警，但任何安全 provider 不可因审计失败而自动放开网络/文件限制；strict 模式的阻断边界必须有文档和测试。
8. 能力清单至少覆盖 `fileRead`、`fileWrite`、`netEgress`、`resourceLimits`、`processControl`，每项值为 `enforced | partial | absent | unknown`。若与现有类型存在冲突，以最小兼容方式扩展并写 ADR。
9. 每条能力声明都应带可追溯的 `platform/backend/profile`，以及状态来源（静态配置、功能探测、后端报告、真实测试结果）；若架构不适合在 manifest 中内嵌证据，至少输出 `evidenceRef` 关联测试报告。
10. **实现基础 Policy CI**：将合成、固定的 keyless fixture 送入纯函数策略判定器，比较当前策略与候选策略的决策 diff。必须覆盖至少 allow→deny、deny→allow、ask/unknown 及不可重放输入；不调用模型、不读取 recorded Sessions、不连公网。
11. 为三层事件预留统一关联字段和事实来源枚举：`policy_decision`、`backend_result`、`os_observation`。P1 可以让 `os_observation` 为 `unavailable`，但不得伪造内核事件。

**P1 验收：**

- REAL-composition 测试经真实 Loader/测试 profile 通过。
- 对当前契约真实可观察的允许、策略拒绝、审批拒绝、普通失败与 runner 失败进行分类；若某类后端拒绝缺少通用字段，则显式标 `unknown/unavailable`。P3 再完成统一结构化拒绝事件（OOB denial events），不得为满足 P1 验收而虚构字段。
- 100% per-file statements/branches/functions/lines 覆盖率、doc-sync、README/文档生成等仓库当前门禁全绿；不得通过关闭/放宽门禁或删减平台分支解决覆盖率问题。
- 所有新增平台特定包都提供可注入平台/平台链/功能探测/launcher 或 runner/临时目录清理的 `*Internals` 等价钩子，并在 README 的独立 `Testing hooks` 章节说明；至少用钩子从单一宿主覆盖所有平台分支。
- 对比框架至少已跑通 DSH-BASE 与 DSH-PLUGIN 的文件、网络、审计基础用例。
- 基础 Policy CI 使用 `packages/sandbox/sandbox-policy/tests/` 的合成固定 fixture，通过 POL-01～POL-07 中适用于 P1 的用例；没有把 recorded Sessions 放入 benchmarks/CI。
- P1 默认不包含薄 journal。若产品负责人在 P0-A 截止前批准纳入，必须以单独 PR/测试门禁加入，并通过写配额语义（`RES-05`）、备份导致的性能退化（`PERF-02`）、备份落盘失败（`ROB-10`）及 fs 写前备份 golden tests；若未获批准或决策逾期，记为 deferred/not-in-scope，不得暗示已交付时间旅行。
- 能力清单的 `enforced` 状态可以追溯到实际机制和证据；缺失的 OS 观察明确显示 `unavailable/unknown`。
- 输出第一份 DSH-BASE vs DSH-PLUGIN vs 可运行竞品的报告，明确安全缺口，同时将 enforcement 结论与 observability/Policy CI 差异分开呈现。

### P2：平台分段的敏感读保护与网络出口控制（高风险阶段）

不得把“三平台 denyRead + 三平台网络隔离”当成一个配置工作包。按以下 PR/子阶段拆分，先拿到各自的强制证据，再决定扩大平台范围：

- **P2a：Linux/macOS 网络出口强制**：优先验证 Linux namespace/bwrap/netns 与 macOS Seatbelt/可用原语；真实原生 TCP 与 Harness 工具旁路用例必须过。
- **P2b：敏感读保护（按 backend 分批）**：DSH 文件工具策略与 OS 子进程 denyRead 分开验收；Windows 不能沿用 WRITE_RESTRICTED 机制的结论来宣称读已受限，需单独设计/评估令牌与 ACE 机制。
- **P2c：Windows 网络/WFP**：P0 先做权限、原生组件和 runner 主机隔离 spike；是否实现 WFP 单独立项决策，不得为凑三平台一致性而退化成代理变量或应用层 deny。当前 Windows CI 使用共享 self-hosted runner 的情况下，禁止直接修改共享主机 WFP 规则；只有专用隔离 runner/临时 VM、并行 job 隔离、规则回滚验证和 runner 联网恢复检查全部落实后，才可执行 WFP 集成测试。管理员权限本身不等于具备安全的测试环境；该实现预算不计入常规 P2a。

任何只在单机可跑的实现都必须配套相应 OS 的 CI lane 或受控自托管 runner；有已配置 CI 路径的测试不能以 `not-run` 结束。

#### 敏感读保护

1. 默认 deny list 先保守，至少考虑 home 下 SSH/云凭据目录，以及 workspace 中用户明确配置的 `.env` / `.pem`；默认集合、路径优先级和例外必须可测、可配置、文档化。
2. 对 DSH 自有文件工具，优先复用已有 canonical path / containment 逻辑；覆盖路径穿越、软链接、大小写与平台路径语义。
3. 对 Shell/子进程只承诺 OS 层后端实际可以强制的路径。若只能在命令预检层做最佳努力，必须命名为 advisory/precheck，manifest 标成 `partial`，不得称为真正的 `denyRead` 沙箱隔离。
4. 读规则与现有三档文件效果模式正交，不能悄悄改变 `read-only` 的既有语义。

#### 网络出口控制

1. 先定义网络边界：区分 Harness 进程自身（模型适配器/控制面）、Harness 的 web fetch/MCP 等工具进程/服务、以及被沙箱约束的 shell/子进程。OS 子进程网络隔离不能自动约束 Harness 自身发出的请求；若 Harness 工具被允许访问网络，必须有独立、可审计的策略，且不能形成受限会话通过 Harness 代 fetch 绕过 allowlist 的隐式后门。反之，不能把 Harness 必需的控制面流量误当成子进程外联而一并切断。
2. 在不改变 `ctx.sandbox` 既有契约的前提下，先评估新增 `ctx.sandboxNetwork` seam 是否确有多 provider/consumer 需求。
3. 代理仅负责 allowlist/域名策略；OS/namespace/WFP/Seatbelt 等底层机制负责封锁直连。只有两层都被真实测试证明有效，相关平台的 `netEgress` 才能标 `enforced`。
4. 配置模型采用明确的 `deny-all | allowlist | unrestricted` 语义；空 allowlist 默认 deny-all；通配符/子域后缀/IDN/IP literal/端口规则都需有确定性定义。
5. 域名处理必须先做规范化和严格校验；禁止直接使用容易发生子串或宽后缀误判的字符串匹配。加入 NUL/控制字符、尾点、大小写、IDN、userinfo、IP literal 等回归用例。
6. 网络 provider 起不来、代理停止、租约释放、环境变量被移除、客户端不遵循代理时必须 fail-closed，绝不静默执行无约束命令。
7. 复用 Anthropic Sandbox Runtime 的设计思想做参考，但不要在没有源码/许可证/生命周期评估前直接复制粘贴代码，也不要未经测试声称上游存在或不存在某项绕过。
8. macOS/Linux/Windows 分别验收；每个平台的支持等级可以不同，但配置输出必须暴露差异。

**P2 验收：**

- P2a 在目标 Linux/macOS CI lane 上对 DSH-PLUGIN 跑完适用的网络测试矩阵，所有关键直连绕过测试均有服务端证据；P2c 的 Windows WFP 结论独立报告，不得用 P2a 结果代替。
- 任何未授权流量到达受控测试服务都属于严重失败，不能用平均分抵销。
- 代理中断和 provider 初始化失败测试证明没有裸奔直连。
- 与 SRT/Codex/nsjail 的同语义用例对比，附 `versions.lock.json`、原始结果和逐个平台说明；Linux/macOS CI lane 必须有实际执行证据。
- `NET-13` 证明 Harness 自身工具流量没有产生未审计旁路，也没有误伤必要控制流量；`NET-14` 对持久 PTY/terminal 生命周期边界给出真实测试结论。

### P3：资源配额与运行生命周期治理

1. 先定义哪些限额需要**硬强制**，哪些仅能由插件计数/告警。建议至少研究 wall-clock、进程数、CPU/内存、文件写入量、工具调用次数。
2. 优先使用现有 subprocess、systemd/cgroup、Windows Job Object 或仓库已有原生基础设施；逐个平台先验证接口和运行权限。
3. 对 `SubprocessSpawnSpec` 等已有契约的扩展需先做使用方检索、兼容评估和 ADR；只有证据支持才新增字段。
4. 配额状态需按 session/call 隔离；并发配额更新须防竞态；执行取消必须杀死/清理全部后代进程与租约。
5. 软降级（例如某阈值后将下一次任务从 `workspace-write` 切为 `read-only`）不能悄悄更改用户语义。若使用，应先通知/审批并留下审计事实；硬限额触发则明确拒绝。
6. **完成结构化拒绝事件**：至少区分 policy deny、approval deny、backend/sandbox denial、runner failure、ordinary command failure、quota exceeded、network unavailable。stderr 仅为诊断辅助，不是唯一判定依据。
7. **实现三层事实关联查询**：以稳定调用 ID 连接 policy decision 与 backend result；当系统提供可用 OS observation 时再关联实际内核/OS 事实。每条事实必须保留来源、时间、关联质量和可用性状态；不能把应用层推断包装成 OS ground truth。
8. 建立事件源 adapter 接口或纯类型契约前，先验证是否至少有两个真实事件来源/消费者；若只有一个消费者，使用最小类型模型，不为“架构完整”而创建无实际意义的 service seam。

**P3 验收：** `RES-*` 用例按平台给出 hard/soft 标记；进程限制测试不能影响宿主；无进程、fd、临时目录和代理租约泄漏；对比结果包含 CPU、内存、启动延迟与超限准确性。`AUD-10`～`AUD-15` 适用用例通过；报告能够清楚显示“策略层拒绝”“沙箱后端报告拒绝”与“OS 观察到的事实”之间的区别。

### P4：Shell/子进程工作区隔离与恢复（薄 journal 之外的时间旅行能力，单独立项）

1. 本阶段是原方向文档中“时间旅行”目标的剩余部分；P1 的 fs 工具薄 journal 不能被描述为 Shell 任意修改恢复。本范围修订需产品负责人显式确认并在 ADR/issue 中留痕。
2. Git 项目优先评估独立 `git worktree` / 专用工作副本；回退通过丢弃隔离工作区实现时，必须明确未跟踪文件、忽略文件、子模块、嵌套仓库及 Git hooks 的行为。
3. 非 Git 文件操作再评估内容寻址备份或真实快照。
4. 不得把“执行前后 stat diff”作为内容恢复的充分机制；删除/覆盖前必须保存可恢复的原内容，或明确不能恢复。
5. 恢复必须展示计划、检查恢复目标、审批、保存恢复前检查点；对并发修改和文件冲突有确定策略。
6. MVP 先只开放人类触发的恢复命令；模型可见恢复工具需后续安全评审。

**P4 验收：** 对创建/修改/覆盖/删除/rename/软链接等分别证明可恢复；在崩溃与冲突场景下不可静默覆盖用户新改动；不声称恢复 Shell 的外部网络、发布、数据库或其他不可逆副作用。

### P5：高级 Policy CI / OS 观察器（可选增强）

- **高级 Policy CI**：扩展 P1 的基础策略回放，增加历史语料版本管理、按 profile/平台生成影响报告、策略变更门禁与基准趋势。先定义数据保留、脱敏和可复现规则；不得调用模型或公网服务。
- **OS 观察器 / eBPF**：仅在有明确用户群、内核覆盖率和权限模型之后启动。优先“观测而不拦截”的研究原型；验证事件可用性、归因准确度、事件丢失、延迟、CPU/RSS、发行、内核矩阵和许可证后才决定是否产品化。
- 若 eBPF 不可用，架构应允许 `os_observation: unavailable`，其他 Harness 审计继续工作；不得把缺失观察误报为“未发生违规”。
- 不将 eBPF 纳入 P1/P2/P3 通过条件，不让它阻塞跨平台基础治理能力。

## 8. 评分规则与发布门槛

### 8.1 报告维度

每个被测对象按下列独立维度报告，不先合成一个模糊的总分：

1. 文件写边界有效性。
2. 敏感读限制有效性。
3. 网络 allowlist 与直连阻断有效性。
4. 资源限额的硬强制程度。
5. fail-closed 行为。
6. 审计与故障可诊断性。
7. 子进程/持久终端覆盖。
8. 启动延迟、稳态开销、内存/CPU 消耗。
9. 安装前置条件、所需权限、平台覆盖和配置复杂度。
10. 可维护性：外部依赖、原生组件、权限负担、许可证与升级成本。
11. **能力清单可信度**：manifest 状态与实际后端测试是否一致，是否存在没有证据却标 `enforced` 的维度。
12. **策略回归能力**：固定语料是否可重放、策略差异是否可解释、误拦截候选是否可以提前发现。此项是 DSH 的治理/可观测性差异，不替代黑盒安全强制测试。
13. **事实关联质量**：policy/backend/OS 事实的关联率、未关联原因及来源可信度；无 OS 事件的竞品应标记“不可观测”，不能推断其没有拒绝能力。
14. **模式语义兼容性**：`danger-full-access` 路径被明确审计；新插件未静默改变该模式既有行为，且报告不将该模式下结果冒充安全隔离通过。
15. **测试隔离性与门禁完整性**：故障注入只命中合成 runner/临时目录，宿主真实 runner 和真实工作区未受影响；平台分支测试钩子完整，覆盖率/文档门禁未被弱化。

安全功能分项应提供“通过/失败/不支持/未运行/未知”状态；另列加权分数作为可选摘要时，必须公开权重。性能不能抵消严重安全失败。

### 8.2 严重失败（Release blocker）

- 已声明 `enforced` 的能力发生未经授权的文件写入或读取。
- 未授权网络请求成功到达本地测试服务，尤其是通过直连 IP、移除代理变量、原生 TCP 客户端或代理故障绕过。
- 网络 provider/runner 不可用时静默按无限制模式执行。
- 审计把 runner failure 错报为 sandbox denial，或把未受强制的能力报告为 `full/enforced`。
- 跨会话策略、文件、租约或配额串线。
- 用户数据在审计/测试结果中泄露；测试越过其临时目录或影响真实系统文件。
- 新增平台分支通过降低/关闭覆盖率门禁、删掉难测分支或只靠静态分析“验收”。
- 受限会话可借 Harness web fetch/MCP 等路径访问本应被禁止的测试目标，且未被独立策略阻止/审计；或网络隔离实现误伤关键控制面却未披露。
- 受支持且已配置 CI runner 的关键用例没有运行，却被报告成 PASS 或用 `not-run` 掩盖。

### 8.3 非严重但必须披露

- 某竞品或平台本身不支持该能力。
- 因 CI 权限/内核配置导致测试无法运行。
- 延迟高于目标但未破坏安全边界。
- Windows 或某 Linux 发行版只达到 `partial`。

这些项不能伪装成 PASS；必须标注原因、复现方式与后续建议。

## 9. 交付物清单

Code Agent 完成后必须留下以下产物（具体路径依仓库规范调整，并在最终报告中指明）：

1. **插件源码与测试**：按 DSH 的 `packages/<group>/<pkg>/`、函数插件/service 导出约定实现；必要的测试 fixture 放在对应包认可的位置。
2. **竞品对比测试工具**：固定放在 `scripts/sandbox-compare/` 的各竞品 adapter、公共 case 定义、受控服务、证据采集器、`versions.lock.json`、`smoke-p1.json` / `smoke-p2.json` 和版本锁校验工具；按 DSH-BASE 单系统基线与后续竞品扩展分 PR 交付。将版本锁校验注册到 `scripts/run-gates.ts`。
3. **原始数据**：每次运行的 JSON / 日志，不将唯一结果只存成表格里的 PASS/FAIL。
4. **汇总报告**：Markdown + CSV/JSON 汇总，至少有 DSH-BASE、DSH-PLUGIN、SRT、Codex、nsjail 的版本、平台能力矩阵、安全用例结果、性能分布及未运行项。
5. **基础 Policy CI**：`packages/sandbox/sandbox-policy/tests/` 中合成固定 keyless fixtures、策略 replay 命令、machine-readable diff JSON、可读的 Markdown 报告和 golden tests；清楚说明它不替代 OS enforcement 测试。录制会话的离线影响分析脚本独立存放在 `scripts/` 或包内 dev 脚本，禁止作为 benchmarks/CI 门禁语料。
6. **三层事实关联契约**：事件类型/来源定义、稳定关联字段、来源与可用性状态，以及至少一份从调用 ID 查询完整事实链的示例输出。
7. **ADR**：关键接口、策略语义、平台限制、外部项目引用/复用决定及安全失败策略。
8. **README / 配置与限制说明**：遵循实际仓库的文档生成、doc-sync 与双语 README 约定；准确说明配置默认值、数据保存与脱敏、平台限制、所需权限、故障行为，以及哪些能力是硬强制/软策略。每个新增平台特定包另设 `Testing hooks`（或仓库约定的等价名称）章节，不能只把测试钩子写在 `Model Experience` 段落里。
9. **CI 接入**：纯单元/Policy CI 合成 fixture 进入常规 CI；复用 `.github/workflows/sandbox.yml` 的四 leg 完整证明与 run-guard，不再新建重复的完整平台矩阵；另设 PR 竞品 smoke lane。完整跨平台/竞品矩阵在现有 master-triggered workflow/对应 master job 中执行。依赖/权限缺失必须显示为带原因和证据的 `blocked/unsupported`，不得在该 lane 已承诺运行的 case 上用 `not-run` 沉默跳过。`ROB-04` 的千次启停和每用例 30 次性能重复都必须是可重跑 CI job/脚本，不要求 Agent 在单一会话里同步跑完。
10. **最终报告**：写明实施了什么、改了哪些包/文件、运行了哪些命令、全部结果、已知缺口、严重失败是否清零、与竞品相比 DSH 的实际优势和不足。
11. **时间旅行范围决策记录**：通过 ADR/issue 明确产品负责人是否接受 P1 的 fs 工具薄 journal、哪些操作可恢复，以及 Shell/子进程恢复延至 P4 的范围变更。未获批准时不把薄 journal 当作默认已确认需求。决策 issue 的 owner 必须是被项目发起人明确指定的产品负责人，截止为 P0-A 结束且早于 P1 首个实现 PR；逾期默认 P1 不包含薄 journal。
12. **离线 Policy 影响分析工具（独立于 CI）**：仅在有授权并完成脱敏设计后读取 recorded Sessions/`snapshots/`；人工触发，输出与基础 Policy CI 不同的报告类型，明确数据版本、过滤与不可重放记录，不得将其放入 benchmarks 固定 fixture。

## 10. 开发阶段的完成顺序

| PR/阶段 | 核心任务 | 规划预算（人日） | 通过门槛 / 可交付成果 |
|---|---|---:|---|
| P0-A | 仓库侦察、基线、调用路径、CI/文档门禁、既有 `sandbox.yml` run-guard 复核、Windows WFP/denyRead 权限与隔离 spike、版本锁 gate、ADR-001 | 3–5 | 有源代码位置与命令的现状报告；明确共享 Windows runner 的 WFP 污染风险与专用 runner 决策；复用现有四 leg，不重复造矩阵；PR smoke/master 完整矩阵的职责确定 |
| P0-B1 | **先跑通 DSH-BASE 单系统**：统一 case schema、受控本地服务、证据采集与 `smoke-p1.json` | 3–5 | DSH-BASE 本机可重跑；保留文件/网络真实副作用证据；为 DSH-PLUGIN 留可复用 adapter seam；JSON smoke 清单与执行数/skip guard 可用 |
| P0-B2/C | **再扩展竞品与既有跨平台 CI**：按 PR 扩展 adapters，复用 `.github/workflows/sandbox.yml` master 完整矩阵；接入 Codex-Windows/WSL2、SRT 与 Linux `nsjail` | 8–12（在 P0-B1 之外） | 第一份报告引用并通过 `versions.lock.json` hash gate；PR smoke lane 轻量运行，完整四 leg 仍在 master 执行；有 CI 路径的关键 case 无静默 `not-run` |
| P1 | 审计账本 + 能力清单 + 基础 Policy CI + REAL-composition；薄 journal 仅在前置决策批准后另列 PR | 10–15（约 2 周，不含薄 journal） | 门禁全绿；真实 Loader 装配；`enforcement` 不被当作通用字段；Policy CI 合成 fixtures/golden 测试通过；未批准或逾期时薄 journal 标记 deferred/not-in-scope，不把范围未决误报为默认实现 blocker |
| P2a | Linux/macOS 网络出口强制 | 12–20 | NET 直连、原生 TCP、Harness 工具流量边界与持久 PTY 生命周期用例通过；服务端证据证明未授权流量未到达 |
| P2b | denyRead（按 DSH 文件工具与 OS 子进程分开，按平台实现） | 12–20（高方差，预期靠近区间上端；必要时再拆 Windows 专项） | 仅对实际测试过的平台/后端标 `enforced`；Windows 读限制不从 WRITE_RESTRICTED 机制推断；P2 smoke 必须包含 FS-11 |
| P2c | Windows WFP 网络强制 | 先做独立 spike；实现预算待 spike 后立项 | 管理员权限、服务/原生组件、安装/卸载与 CI 运行条件经书面评估；必须使用专用隔离 runner/临时 VM，禁止在共享 runner 上直接改规则；不可行时明确标 `unsupported/absent`，不伪造应用层替代 |
| P3 | 资源配额 + 结构化拒绝事件 + 三层事实关联 | 10–15 | RES、AUD-10～15 与取消/泄漏测试通过；事件来源明确；完整长循环跑 CI job |
| P4 | Shell/子进程工作区隔离与恢复 | 单独立项 | 显式范围决策；证明内容级可恢复而非只发现变化 |
| P5 | 高级 Policy CI / OS 观察器（含可选 eBPF） | 可选、单独 ADR | 覆盖率、权限、许可证、事件归因与性能证据齐全 |

**预算重估：** P0–P3 核心范围规划为约 **60–90 人日**，受平台与仓库门禁影响；Windows WFP 的完整产品化实现、P4 时间旅行恢复和 P5 观察器不纳入该核心预算。竞品扩展的 8–12 人日建立在 P0-B1 已交付的前提上，不得把 3–5 人日误读为完成所有竞品适配。预算是阶段控制上限/重新评估触发器，不是要求 Agent 在预算不够时削减测试证据。

### 10.1 时间盒与升级规则（强制）

- **P0-A 预算/时间盒：3–5 人日。** 前 3 人日交付仓库现状、已有 CI 复用方案和调用路径初稿；最多使用到第 5 人日完成 Windows WFP 权限/主机污染/专用 runner spike 与 gate 设计。某一事实超过 4 个工作小时仍无法确认时登记未决项并继续收集可复核证据；到第 5 人日仍未得到结论就提交 `BLOCKED`，不得猜测 WFP 结论，也不得因此预先批准 P2c。
- **P0-B1 时间盒：最多 5 人日**交付 DSH-BASE 单系统和 `smoke-p1.json`；只有该交付具备可复现 JSON、真实副作用证据和零 self-skip 断言后，才能开始把适配器扩至全部竞品。
- **P0-B2/C 时间盒：8–12 人日预算**按竞品 adapter 分 PR；任一竞品超过预算时保留已完成的可复现报告，提交 blocker，不阻塞 DSH-BASE 基线，也不得将缺失竞品写成 PASS。
- **P1 预算：10–15 人日**；全仓 100% 覆盖率、REAL-composition、doc-sync/README 门禁必须保留。若测试钩子/兼容边界导致超时，优先缩小未批准的功能范围，不删安全测试。
- **P2 分段立项**：P2a 与 P2b 分开提交；P2c 在权限及 runner 污染 spike 后独立估算。P2b 的 12–20 人日只是规划区间而非承诺，Windows 新令牌/ACE 和逃逸矩阵若触及上限则拆成平台子阶段。每个阶段出现未授权真实副作用立即停止该用例扩张、封存日志并按 release blocker 升级。
- **P3 长循环与性能**只由自动化 job 运行，提供可复跑命令、超时和清理机制。Agent 单会话不需要、也不应等待所有 1000 次循环与每项 30 次重复结束。
- 所有阶段超出预算 20%、关键阻塞超过 4 个工作小时或 CI lane 无法提供必要权限时，输出 `BLOCKED` 报告，至少包含已确认事实、命令和环境、证据等级、未完成项、风险以及 1–3 个最小下一步选项。

## 11. 最终报告模板

最终回复须按此结构提交，不要只说“测试通过”。报告必须附 `versions.lock.json`（或其不可变 artifact 引用及 hash）、CI run 链接/编号和原始数据路径。最少冒烟子集与阶段门禁按下述节奏执行：

- **每次提交/PR 轻量 gate**：包单测、合成 Policy CI golden tests，以及本阶段的 smoke JSON。P1 使用 `smoke-p1.json`（9 个 case）；P2b denyRead 成为核心能力后切换为 `smoke-p2.json`，必须包含 `FS-11`，并按当前已交付能力覆盖必要的别名与 Harness/PTY 边界用例。不运行全部 60+ cases × 所有系统/平台。
- **PR 与 master 分工**：PR 新增/运行轻量竞品 smoke lane；不要要求 `.github/workflows/sandbox.yml` 的完整矩阵在 PR 重跑，因为该 workflow 当前有意只在 push `master` 时运行。master push 继续执行既有 `bwrap/landlock/landlock-arm/seatbelt` 完整矩阵，并沿用每个 leg 的 run-guard，保证 e2e 文件实际执行且没有 self-skip。PR smoke 不能替代 master 完整矩阵，master 全矩阵也不能替代 PR 的快速反馈。
- **夜间/发布前**：扩展完整安全矩阵、故障注入；`ROB-04` 的至少 1000 次生命周期循环和性能用例每项至少 30 次重复通过可重跑 CI job 执行，不要求单个 Agent 会话等待所有循环完成。发布报告必须列出运行次数和漏跑原因。

若超过阶段时间盒、CI 环境不具备必要权限，或证据与计划结论冲突，Agent 应停在阶段边界提交 blocker 与原始证据；不可把未经验证的项目标为 PASS。

1. **结论摘要**：DSH-PLUGIN 相对 DSH-BASE 实际新增的安全保证；相对每个竞品的优势/差距。
2. **版本与环境表**：commit、OS/kernel、工具版本、权限、配置和缺失依赖。
3. **安全矩阵**：FS、NET、RES、AUD、ROB 各 case 的 PASS/FAIL/unsupported/not-run/unknown，附证据。
4. **创新能力验收**：能力清单及每项 evidenceRef；Policy CI 的策略 diff 样例与 POL-* 结果；三层事实关联示例，注明 OS observation 是否真实可用。
5. **性能表**：native baseline、DSH-BASE、DSH-PLUGIN、SRT、Codex、nsjail 的 median/p95 和开销比。
6. **严重失败**：未解决项、风险等级、是否阻止发布。
7. **修改文件与接口变化**：指出新增/变更包、是否修改既有 seam、是否产生迁移/版本影响。
8. **运行命令**：准确复制可以复现的命令与执行环境。
9. **下一步建议**：只依据已测结果决定，不以 README 或预测替代证据。

## 12. 官方参考资料

以下链接是实施时的起点，不代替固定版本的代码审查和实际验证。**本节中的 `deepseek-ai/deepseek-harness` 路径仅为示例**；必须先用本机 `git remote -v` 核实真实 owner/repository，并将本节所有 DSH 自身链接（仓库、architecture、sandbox 包组、packages 规则）替换为 remote 对应 URL。不得因为本节示例链接而覆盖文件头部“以 remote 和 checkout 为准”的规则。

- DeepSeek Harness 仓库与开发约定（示例 URL，须按 remote 核实结果替换）：<https://github.com/deepseek-ai/deepseek-harness>
- DSH 架构：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- DSH sandbox 包组：<https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sandbox>
- DSH 包规则：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/AGENTS.md>
- Anthropic Sandbox Runtime：<https://github.com/anthropics/sandbox-runtime>
- Anthropic Sandbox Runtime releases：<https://github.com/anthropics/sandbox-runtime/releases>
- OpenAI Codex：<https://github.com/openai/codex>
- OpenAI Codex sandbox 文档入口：<https://developers.openai.com/codex/sandboxing>
- Google nsjail：<https://github.com/google/nsjail>
- gVisor 性能指南（仅探索性比较）：<https://gvisor.dev/docs/architecture_guide/performance/>

---

## 给 Code Agent 的一句话执行要求

**先核实仓库门禁与版本，固定在 `scripts/sandbox-compare/versions.lock.json`，并将版本锁校验接入 `scripts/run-gates.ts`；复用 `.github/workflows/sandbox.yml` 既有 master 完整矩阵及其 no-self-skip run-guard，不新建重复矩阵，同时增加 PR 轻量 smoke lane。先交付 DSH-BASE 单系统基线和版本化 `smoke-p1.json`，P2b denyRead 后切换到包含 `FS-11` 的 `smoke-p2.json`，再按 PR 扩展 Codex-Windows/WSL2、Linux/macOS 的 SRT/Codex 与 Linux `nsjail`。Policy CI 必须使用 `packages/sandbox/sandbox-policy/tests/` 中的合成固定 fixtures，历史会话只能用于人工触发的离线影响分析；审计不得假设通用 `enforcement` 字段存在；新增平台分支必须提供等价 `*Internals` 测试钩子并保持仓库 100% 覆盖率门禁。将网络分为 P2a Linux/macOS、P2b denyRead、P2c Windows WFP 独立评估；WFP 不得在共享 self-hosted runner 上修改，必须先解决专用隔离 runner 与主机污染风险；原生 Windows 的 SRT 预期记 `unsupported`，WSL2 单独比较。薄 journal 默认不纳入 P1，只有产品负责人于 P0-A 截止前书面批准后才可作为追加 PR，且必须测试 `RES-05` 写配额语义、`PERF-02` 备份开销和 `ROB-10` 备份失败；Shell 恢复仍为 P4。所有长循环/30 次性能重复放进 CI job，按时间盒升级阻塞而非削减证据。eBPF 是可选观察器研究，不能阻塞 MVP。任何已声明强制的边界被绕过，都是发布阻塞问题。
