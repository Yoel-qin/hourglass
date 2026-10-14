# hourglass 最终报告（P0 + P1 + P2a + P2b 交付）

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
| fail-closed（ROB-01） | ✅ | ✅（含 net/read 层） | n/a | n/a |
| 审计分类（AUD-02/11） | n/a | ✅ | n/a | n/a |

\* SRT 的 SSRF 防护拒绝 loopback 与本机地址作为上游——单容器环境无法验证其 allow 通道；
其 deny 语义已由 NET-02..06 真实验证（此限制属环境不可比，非 SRT 缺陷）。
\*\* nsjail 的隔离粒度是命名空间级（全断），无法表达域名 allowlist——机制差异，如实呈现。

**总分：DSH-BASE 9/8/2、DSH-PLUGIN 19/0/0（满分）、SRT 15/1/3、NSJAIL 13/1/5。**
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

## 3. 安全矩阵（smoke-p1，36 结果）

原始数据：`reports/runs/compare-20261014T011836Z/compare.json`（结构化证据）+ `summary.md`。
- PASS 判据全部来自外部世界观察（文件系统快照差分 / 服务端 canary 记录），非 stderr。
- UNSUPPORTED 仅用于 AUD×非 DSH-PLUGIN（observability 不可比）与 ROB-01×非 DSH（无 runner 概念）。
- CODEX 全部 not-run（无凭证），每条带原因。

## 4. 创新点验收

- **能力清单**：`buildManifest` 诚实规则 + `/sandbox-capabilities` 命令；evidenceRef 指向
  DSH 源码 commit 或 compare case id。
- **Policy CI**：golden（13 决策字节稳定）+ POL-01/03/04/05/07 用例绿；POL-02 的 diff 输出含
  allow→deny、reason-only 分类。
- **三层事实关联**：byCall(callId) 返回 begin+end 链；backend.source 精确到 value.sandbox/meta.sandbox；
  os_observation=unavailable 显式标注。

## 5. 性能

未纳入本阶段（计划 §6 要求 30 次重复 + 独立 CI job；compare 报告含每次 case durationMs 原始值）。

## 6. 严重失败与缺口

- **DSH 网络出口缺口（6 fail）**：非 hourglass 引入（BASE 与 PLUGIN 相同）；属 P2a 范围。
- RES/性能/NET-13/14 未实现（P2/P3 范围，case 池已预留）。
- 覆盖率门禁：hourglass 测试未接入 DSH per-file 100% coverage 跑法（独立项目按 ADR-001 不进
  DSH 的 run-gates；hourglass 自身 58 测试覆盖全部新分支）。

## 7. 修改文件与接口变化

DSH 仓库：**零修改**（只读引用）。全部产出在 hourglass 项目（packages/×3、scripts/sandbox-compare、
docker、docs/ADR-001、reports）。

## 8. 复现命令

```bash
docker build -t hourglass-test -f docker/Dockerfile .   # 需先 vendor（见 docker/vendor README 注记）
docker run --rm --privileged -v "$(pwd)/reports:/opt/reports" \
  --entrypoint /usr/local/bin/hourglass-entrypoint hourglass-test run-all
# gates（版本锁 sha256）→ unit（7 files/58 tests）→ compare（36 结果 JSON+MD）
```

## 9. 下一步建议（依据已测结果）

1. **P2a Linux 网络出口**：SRT 已证明 bwrap+netns+代理 allowlist 可行且全部 NET 拦截；
   DSH 可最小化复用该模式（不引生产依赖，见 ADR-001 约束）。
2. **P2b denyRead**：SRT 的 denyRead 语义可直接对齐 FS-11/12（case 已就绪，SRT 预期 PASS、DSH 预期
   FAIL 暴露缺口）；DSH 侧按 bwrap ro-bind 白名单或 Landlock 读限制设计。
3. Codex lane 需要凭证才能从 not-run 升级（versions.lock 待审更新）。
