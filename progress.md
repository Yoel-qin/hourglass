# Progress — 会话日志

## 会话 1（2026-10-13）

### 环境与侦察（P0-A，完成）
- Docker 29.7.2；credential helper 问题用项目级 DOCKER_CONFIG=.docker-config 绕过（不动用户配置）
- 容器能力实测：默认 seccomp 阻止 userns；--security-opt seccomp=unconfined 后 unshare -U 可用但 bwrap 仍失败；**--privileged 下 bwrap 完全可用** → 测试容器用 privileged（专用一次性容器，仅挂载 reports 输出目录）
- DSH master d743267（本地=远程），工作区干净；Node v22.20.0 / pnpm 11.28.5
- 竞品版本锁定（GitHub API 实测）：SRT v0.0.79 (d9aac20)、Codex 0.162.1 (092d3ac)、nsjail 3.6 (f784755)
- 两个 Explore agent 完成 DSH 架构/沙箱/CI 侦察，关键事实入 findings.md：
  - 工具事件：pre-execute/execute/post-execute（waterfall）+ result（emit）
  - bash 工具把 sandbox 事实放 result.value.sandbox（tool-bash index.ts:170）
  - 网络出口控制是 DSH 空白；SandboxMode 只管文件效果
  - 外部插件接入：packages/*/* workspace + cordis.patch.yml insert
  - e2e 驱动模式：new Context() + ctx.plugin(LocalSandboxProvider) + confine + spawnSync

### 代码产出
- packages/audit（@hourglass/sandbox-audit）：types/redact/classify/ledger/index + 4 个测试文件 + REAL-composition loader 测试（cordis.yml + driver.ts + loader.spec.ts）
  - backend 事实从 value.sandbox 提取（tool-bash 契约），meta 兜底；source 标签区分
  - 分类器：结构化信号优先，纯 stderr 匹配不上沙箱拒绝
- packages/capabilities（@hourglass/sandbox-capabilities）：静态矩阵（证据=DSH 源码 commit）+ 真实探测 + 诚实规则（enforced 需要 probe/test 证据，否则降 unknown）+ 测试
- packages/policy-ci（@hourglass/policy-ci）：纯语义模型（mode 解析优先级 + containment + 域名规范化 NET-09）+ replay/diff + 合成 fixtures + golden 测试（golden 文件待容器内生成）
- scripts/sandbox-compare/：schema、cases（19 个）、net-service（本地受控服务）、versions.lock.json、validate-versions-lock.ts、smoke-p1/p2.json、adapters（DSH-BASE/DSH-PLUGIN/SRT/NSJAIL/CODEX）、driver（dsh-driver.ts、dsh-plugin-driver.ts）、run.ts（执行器+判定+报告）
- docker/Dockerfile（tools→dsh→test 三阶段）+ compose.yaml（privileged）+ entrypoint.sh + .dockerignore

### 进行中
- Docker 镜像构建后台运行中（任务 bmap21gr5）

### 待办
- golden 文件生成（policy-ci baseline-replay.golden.json）
- 容器内：pnpm install 融合、跑单测、跑 loader smoke、跑 compare
- README、ADR-001、最终报告
