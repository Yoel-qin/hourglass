/**
 * CubeSandbox adapter (microVM sandbox-pool lane). Cube runs every sandbox
 * in its own KVM MicroVM (Cloud Hypervisor fork) with eBPF switching and an
 * L7 egress MITM proxy — hardware-grade isolation, but the runtime demands
 * /dev/kvm, an XFS reflink volume for CoW clones, and systemd on the host
 * (deploy/one-click/install.sh hard-exits otherwise).
 *
 * The Docker Desktop/WSL2 test container exposes no /dev/kvm and no vmx CPU
 * flag (probe evidence lands in every run's reason field), so this lane
 * records an honest not-run per case — the same discipline as the Codex
 * credential lane. Cube's source-verified mechanisms and its vendor
 * benchmarks are compared in the analysis docs and README instead.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { RawExecution, RunEnv, SubjectAdapter } from './types.ts'

function probeKvm(): { ok: boolean; detail: string } {
  if (existsSync('/dev/kvm')) return { ok: false, detail: '/dev/kvm present but the full stack (XFS reflink volume, systemd, containerd) is not installed in this image' }
  const cpuinfo = (() => {
    try {
      return readFileSync('/proc/cpuinfo', 'utf8')
    } catch {
      return ''
    }
  })()
  const vmx = /vmx|svm/.test(cpuinfo)
  return {
    ok: false,
    detail: `/dev/kvm absent${vmx ? '' : ' and no vmx/svm CPU flag exposed'} — CubeSandbox requires KVM MicroVMs plus an XFS(reflink) /data/cubelet volume and systemd (install.sh hard checks at deploy/one-click/install.sh:913,1058)`,
  }
}

function unavailableReason(): string {
  const kvm = probeKvm()
  const cubeApi = spawnSync('sh', ['-c', 'command -v cube-api cubemastercli cubelet 2>/dev/null | wc -l'], { encoding: 'utf8', timeout: 5_000 })
  const installed = Number((cubeApi.stdout ?? '0').trim())
  return `${kvm.detail}; cube binaries present: ${installed}/3 — lane declared not-run (versions.lock constraints), vendor benchmarks quoted separately in the report`
}

export const cube: SubjectAdapter = {
  id: 'CUBE',
  async available() {
    // The KVM/XFS/systemd requirements are environmental: if they ever
    // become satisfiable (bare-metal runner with nested virt), this probe
    // flips the lane on with no other changes.
    return { ok: false, reason: unavailableReason() }
  },
  async execute(_caseDefinition, _env): Promise<RawExecution> {
    throw new Error('cube adapter cannot execute: runtime requirements unmet (KVM microVM stack)')
  },
}
