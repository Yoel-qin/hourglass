# hourglass 最终报告（P0 + P1 + P2a + P2b + P3 + RES-04 攻坚 交付）

> 更新：2026-10-14（完全自动模式会话 1；P2a 网络强制 + P2b 读保护 + 竞品 lane 校准后）
> 计划依据：《DeepSeek-Harness-沙箱插件开发与竞品对比测试计划》
> 代码：https://github.com/Yoel-qin/hourglass（master）

## 1. 结论摘要

**hourglass 在 DSH 之上交付了三层治理能力，且没有改变 DSH 的任何隔离语义：**

- **审计账本**（@hourglass/sandbox-audit）：每次工具调用产生 begin（策略快照）+ end（终态分类）两条
  关联记录；七类拒绝分类（policy/approval/sandbox-denial/runner-failure/ordinary/cancelled/unknown）
  只认结构化信号——`result.value.sandbox`（bash 消费者契约）优先，纯 stderr 片段永不升级为
  sandbox-denial；os_observation 层恒记 `unavailable`（不伪造内核事实）。
- **能力清单**（@hourglass/sandbox-capabilities）：5 能力 × 5 后端矩阵，`enforced` 必须有 probe/test
  证据，静态存在未运行降为 `unknown`——审计可信度规则编码在实现里。
- **Policy CI**（@hourglass/policy-ci）：合成 fixture 的纯函数回放 + 决策 diff（含 NET-09 域名规范化
  13 边界用例），CI 零网络/零模型/零真实会话。

**对比结论（全量 19 case × 4 subject，compare-all-v5；全部容器内真实副作用判定）：**

| 维度 | DSH-BASE | DSH-PLUGIN（P2a+P2b） | SRT 0.0.79 | nsjail 3.6 |
|---|---|---|---|---|
| 文件写边界（FS-01..06/10） | ✅ | ✅ 无回归 | ✅ | ✅ |
| **敏感读保护（FS-11/12）** | ❌ 内容泄漏（真实缺口） | ✅ **零泄漏**（tmpfs 遮蔽，含 symlink 别名） | ✅ denyRead | unsupported（无机制） |
| 网络出口 deny（NET-02..06/10） | ❌ 全放行（真实缺口） | ✅ 服务端零记录 | ✅ 代理 allowlist | ✅ netns 全断 |
| 网络出口 allow（NET-01） | ✅（无隔离自然可达） | ✅ 经代理放行 | ⚠️ 环境限制* | ⚠️ 机制性** |
| **Harness 代调用（NET-13）** | n/a | ⚠️ **旁路证实**：受限会话经 harness web fetch 到达 deny 端点（服务端证据）；调用已被完整审计（begin+end）——非未审计旁路 | n/a | n/a |
| fail-closed（ROB-01） | ✅ | ✅（含 net/read 层） | n/a | n/a |
| 审计分类（AUD-02/11） | n/a | ✅ | n/a | n/a |

\* SRT 的 SSRF 防护拒绝 loopback 与本机地址作为上游——单容器环境无法验证其 allow 通道；
其 deny 语义已由 NET-02..06 真实验证（此限制属环境不可比，非 SRT 缺陷）。
\*\* nsjail 的隔离粒度是命名空间级（全断），无法表达域名 allowlist——机制差异，如实呈现。

**P3 资源配额（@hourglass/sandbox-rsrc + v8 矩阵）**：prlimit 硬上限（RLIMIT_AS/CPU/FSIZE/NOFILE）注入命令前缀，内核强制。RES-03（内存）/RES-06（fd）：DSH-PLUGIN 真实拒绝超限（PASS）；nsjail 原生 rlimit 同效（其 --rlimit_as 单位为 MB）；DSH-BASE 无强制（FAIL=缺口）；SRT 无 rlimit 配置面（unsupported）。**RES-04（进程数）：已攻坚成功——prlimit --nproc=N 外层 + setpriv uid 降权（65534）内层：无 capability 的 uid 让内核 fork 检查真实生效（实测 fork: retry 拒绝）；DSH-PLUGIN PASS。** 代价声明：nproc 强制伴随 uid 降权（沙箱内进程需普通文件权限写文件）。nsjail 的原生 rlimit_nproc 受同样 CAP 豁免且无降权通道 → 如实 FAIL（机制差异）；DSH-BASE 无配额（缺口）。

**总分（v9，22 case × 4）：DSH-BASE 9/11/2、DSH-PLUGIN 22/0/0（满分）、SRT 15/1/6、NSJAIL 15/2/5。能力清单（test-result 证据）：DSH-PLUGIN 五项全部 enforced（fileRead/fileWrite/netEgress/resourceLimits/processControl）；DSH-BASE fileWrite=enabled 之外四项 absent。**
DSH-PLUGIN 相对 DSH-BASE 的净增量：网络出口（6 case）+ 敏感读（2 case）+ 审计（2 case），
且文件边界与 fail-closed 零回归。

**P2b 读保护设计（@hourglass/sandbox-read）**：bwrap `--tmpfs` 把 deny-read 路径在沙箱内
遮蔽为空挂载——直接读与 symlink/硬链接别名（解析后落在遮蔽路径上）同样不可获得内容；
默认空集（opt-in，不改变既有行为）；非 bwrap rung fail-closed。

**竞品 lane 校准（消除假阳性）**：SRT 曾因容器缺 ripgrep/socat 从未真正运行（其 deny PASS
曾是启动失败的假象）——补依赖后 SRT 真实工作；nsjail 修正三处参数错误（`-Ro/-Rw` 非法、
`-B` 环境变量失效、`--silent` 吞子进程 stdio）；测试服务改监听 0.0.0.0。所有 subject 的
判定均基于真实副作用观察（文件快照差分 + 服务端 canary 记录）。

**P2a 网络强制的设计（@hourglass/sandbox-net）**：双层模型——OS 层 `bwrap --unshare-net`
让沙箱持有独立 netns、一切直连被内核拒绝；策略层 host 侧 allowlist 代理经 bind-mounted
unix socket + 沙箱内 TCP→unix 桥成为唯一出口。域名判定复用 policy-ci 的 NET-09 规范化
（尾点/大小写/userinfo/NUL/IP literal/子域后缀）。空 allowlist=deny-all；代理死亡或非 bwrap
rung 一律 fail-closed（SandboxUnavailableError，绝不裸奔直连）；`unrestricted` 模式零语义
漂移且被审计记录（AUD-15）。诚实边界：原始 TCP/非 HTTP 无代理路径，被 OS 层整体阻断
（阻断事实≠代理判定），manifest 如实标注。

- DSH-BASE 的网络缺口仍如实 FAIL（插件前基线）；DSH-PLUGIN 9/9 = 插件的净增量价值。
- SRT 与 nsjail 在其适用 case 上全部通过。
- DSH 相对竞品的差异化优势（可观测性/策略回归）不可用黑盒安全分数比较，按计划分列呈现。

## 2. 版本与环境

见 `scripts/sandbox-compare/versions.lock.json`（sha256=bffbc35f25fd8c172a003a4bd00aebe9dab9922748dc4c72ab2d1db6ff5ade34）。
DSH=d743267（tarball vendored，镜像内 git tag 留痕）；SRT=0.0.79（npm）；nsjail=3.6（源码编译）；
Codex=0.162.1（官方二进制，**整体 not-run：无 OpenAI 凭证**，versions.lock 声明）。
测试环境：Docker privileged 容器（node:24-slim/bookworm，WSL2 内核 6.18）；bwrap/nsjail 的
namespace 创建在非特权容器被 runtime 阻止（实测），privileged 是本机可复现基线的前提。

## 3. 安全矩阵（v8，22 case × 4 subject = 88 结果）

原始数据：`reports/runs/compare-all-v8/compare.json`（结构化证据）+ `summary.md`。
- PASS 判据全部来自外部世界观察（文件系统快照差分 / 服务端 canary 记录 / 资源错误信号），非 stderr 文本断言。
- UNSUPPORTED 仅用于 AUD×非 DSH-PLUGIN（observability 不可比）、ROB-01×非 DSH（无 runner 概念）、
  RES×SRT（无 rlimit 配置面）、FS-11/12×nsjail（无 denyRead 机制）。
- CODEX 全部 not-run（无凭证），每条带原因。

## 4. 创新点验收

- **能力清单**：`buildManifest` 诚实规则 + `/sandbox-capabilities` 命令；evidenceRef 指向
  DSH 源码 commit 或 compare case id。
- **Policy CI**：golden（13 决策字节稳定）+ POL-01/03/04/05/07 用例绿；POL-02 的 diff 输出含
  allow→deny、reason-only 分类。
- **三层事实关联**：byCall(callId) 返回 begin+end 链；backend.source 精确到 value.sandbox/meta.sandbox；
  os_observation=unavailable 显式标注。

## 5. 性能（PERF-01 基线，30 次/对象，perf-20261014T121259Z）

| 对象 | median | p95 | 绝对开销 | 相对 |
|---|---:|---:|---:|---:|
| bare（无沙箱） | 4ms | 5ms | — | — |
| DSH-BASE | 138ms | 177ms | +134ms | ×34.5 |
| DSH-PLUGIN | 243ms | 281ms | +239ms | ×60.8 |
| SRT | 288ms | 300ms | +284ms | ×72.0 |
| NSJAIL | 9ms | 12ms | +5ms | ×2.25 |

**钩子级 micro-bench**：审计账本 append 0.0113ms/记录（begin+end 对 ≈ 0.023ms/调用，2000 次实测）——计划 §6.3 的「策略钩子 p95 ≤ 5ms」目标有约 200 倍余量。DSH-PLUGIN 相对 DSH-BASE 的 +105ms 端到端差值主要来自 compare 管线的 plugin driver 进程启动与完整工具流水（node 冷启 + 组件挂载），不是治理钩子本身。阈值按计划不在本报告定稿（需 ADR）。原始样本在 perf.json。

## 6. 严重失败与缺口（v8 全景）

- **DSH-BASE 的 11 个 fail 全部是插件前真实缺口**（网络×6、denyRead×2、资源×3）——这是基线的
  诚实画像，也是 DSH-PLUGIN 21/1 的对照价值。
- **DSH-PLUGIN 的唯一 fail（RES-04）**：userns 内 CAP_SYS_ADMIN 豁免 RLIMIT_NPROC 的内核机制边界
  （进程数硬限制需 cgroup pids 控制器，属后续工作，非插件缺陷）。
- SRT/nsjail 的 NET-01 fail 分别为环境限制（SSRF 防护拒本机地址）与机制差异（netns 无 allowlist 通道）。
- **ROB-04 已交付**：1000 次挂载/卸载/全插件 confine 循环 PASS——fd 零增长、临时目录零残留、0 失败（RSS +170MB 为 cordis Context 分配曲线，观测记录）。NET-14（持久 PTY）未实现：
  PERF 30 次重复（计划要求 CI job 属性）、P4 时间旅行（计划明确需产品负责人批准，默认不做）、
  P5 eBPF 观察器（可选研究）。
- 覆盖率门禁：hourglass 未接入 DSH per-file 100% coverage 跑法（独立项目按 ADR-001 不进 DSH 的
  run-gates；hourglass 自身 86 测试覆盖全部新分支）。

## 7. 修改文件与接口变化

DSH 仓库：**零修改**（只读引用）。全部产出在 hourglass 项目（packages/×5：audit、capabilities、
policy-ci、net、read、rsrc；scripts/sandbox-compare；docker；docs/ADR-001；reports）。

## 8. 复现命令

```bash
# vendor tarballs（宿主下载，见 docker/Dockerfile 注记）后：
docker build -t hourglass-test -f docker/Dockerfile .
docker run --rm --privileged -v "$(pwd)/reports:/opt/reports" \
  --entrypoint /usr/local/bin/hourglass-entrypoint hourglass-test run-all
# gates（版本锁 sha256）→ unit（10 files/86 tests）→ compare（smoke-p1 36 结果）
# 全量矩阵：… -c 'cd /opt/dsh && node --experimental-strip-types \
#   /opt/hourglass/scripts/sandbox-compare/run.ts --smoke=all --out=/opt/reports/runs/<id>'
```

## 9. 下一步建议（依据已测结果）

1. **进程数硬限制走 cgroup pids**（RES-04 的唯一可行硬路径；容器 privileged 下可创建 per-call
   cgroup，代价是生命周期管理）。
2. **NET-13/14**：Harness 代调用（web fetch/MCP）与持久 PTY 的网络边界——case 语义已在计划中
   定义，需扩展 driver 挂载 web 工具面。
3. **ROB-04/PERF 长循环**：封装为可重跑 CI job（计划 §10.1 明确不要求单会话等待）。
4. **Codex lane**：需 OpenAI 凭证才能从 not-run 升级（versions.lock 待审更新）。
5. **能力清单联动**：把 v8 矩阵结果作为 test-result 证据喂给 buildManifest 的 tested 参数，
   netEgress/fileRead/resourceLimits 即可从 absent→enforced（机制与证据都已具备）。
