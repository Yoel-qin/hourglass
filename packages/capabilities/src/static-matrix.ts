/**
 * Static capability knowledge per DSH back-end, read off the launch
 * configuration in the DSH source tree (commit pinned in evidenceRef).
 *
 * Rules the manifest builder enforces on top of this table:
 * - `absent` may rest on static analysis (no mechanism exists to test).
 * - `enforced` requires probe or test-result evidence; a statically-present
 *   mechanism without a run becomes `unknown`.
 * - `partial` describes a mechanism that covers part of the surface.
 * @module @hourglass/sandbox-capabilities
 */

import type { CapabilityEntry, SandboxBackendId } from './types.ts'

/** DSH commit the static facts were read from. */
export const DSH_SOURCE_COMMIT = 'd743267388641bc76f17c45ce8b4c231aed1d32c'

const PROFILES_REF = `DSH packages/sandbox/sandbox-local/src/profiles.ts @ ${DSH_SOURCE_COMMIT}`
const INDEX_REF = `DSH packages/sandbox/sandbox-local/src/index.ts @ ${DSH_SOURCE_COMMIT}`
const ACL_README_REF = `DSH packages/sandbox/sandbox-windows-acl README + src @ ${DSH_SOURCE_COMMIT}`
const SANDBOX_SEAM_REF = `DSH packages/sandbox/sandbox/src/index.ts @ ${DSH_SOURCE_COMMIT}`

const NET_OUTSIDE_VOCABULARY = 'SandboxMode deliberately excludes network egress (dsh-sandbox seam docs)'
const RESOURCES_OUTSIDE = 'no rlimit/cgroup/quota parameters exist in any backend profile'

type Matrix = Record<string, CapabilityEntry>

/**
 * Per-backend static facts. Notes name the concrete mechanism (or its
 * absence) so a reader can check the claim against the referenced source.
 */
export const STATIC_MATRIX: Readonly<Record<SandboxBackendId, Matrix>> = {
  bwrap: {
    fileWrite: {
      status: 'enforced',
      evidence: 'static-config',
      evidenceRef: PROFILES_REF,
      note: 'read-only root bind plus explicit workspace/tmp bind whitelist; kernel returns EROFS outside it',
    },
    fileRead: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: PROFILES_REF,
      note: 'entire root mounted read-only-readable; no deny-read mechanism exists in the profile',
    },
    netEgress: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: `${PROFILES_REF} (${NET_OUTSIDE_VOCABULARY})`,
      note: 'no --unshare-net or any network filtering flag in bwrapProfileArgs',
    },
    resourceLimits: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: PROFILES_REF,
      note: RESOURCES_OUTSIDE,
    },
    processControl: {
      status: 'partial',
      evidence: 'static-config',
      evidenceRef: PROFILES_REF,
      note: '--unshare-pid gives a private PID namespace and --die-with-parent reaps with the parent; no process-count/CPU/memory cap',
    },
  },
  landlock: {
    fileWrite: {
      status: 'enforced',
      evidence: 'static-config',
      evidenceRef: PROFILES_REF,
      note: 'landlockGrantArgs grants write only to an explicit readWrite set; kernel denies the rest',
    },
    fileRead: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: PROFILES_REF,
      note: "readOnly: ['/'] grants read everywhere; the backend's read-restriction capability is unused by DSH",
    },
    netEgress: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: `${PROFILES_REF} (${NET_OUTSIDE_VOCABULARY})`,
      note: 'DSH applies Landlock filesystem rules only; no network rule set is constructed',
    },
    resourceLimits: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: PROFILES_REF,
      note: RESOURCES_OUTSIDE,
    },
    processControl: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: PROFILES_REF,
      note: 'Landlock has no process-count or visibility primitive in use here',
    },
  },
  seatbelt: {
    fileWrite: {
      status: 'enforced',
      evidence: 'static-config',
      evidenceRef: PROFILES_REF,
      note: "SBPL (deny file-write*) with explicit writable subpath allowances",
    },
    fileRead: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: PROFILES_REF,
      note: 'profile denies writes only; reads are unrestricted',
    },
    netEgress: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: `${PROFILES_REF} (${NET_OUTSIDE_VOCABULARY})`,
      note: 'no (deny network*) clause exists in the generated SBPL',
    },
    resourceLimits: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: PROFILES_REF,
      note: RESOURCES_OUTSIDE,
    },
    processControl: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: PROFILES_REF,
      note: 'no process-related SBPL clauses in the profile',
    },
  },
  'windows-acl': {
    fileWrite: {
      status: 'partial',
      evidence: 'static-config',
      evidenceRef: INDEX_REF,
      note: "WRITE_RESTRICTED token plus per-workspace SID grants; DSH itself reports enforcement 'partial' (hardlink aliasing, standing grants)",
    },
    fileRead: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: ACL_README_REF,
      note: 'WRITE_RESTRICTED restricts writes only; reads, network, and process visibility are unrestricted',
    },
    netEgress: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: ACL_README_REF,
      note: 'no network filtering exists in the ACL backend',
    },
    resourceLimits: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: ACL_README_REF,
      note: RESOURCES_OUTSIDE,
    },
    processControl: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: ACL_README_REF,
      note: 'no Job Object or process-count limit is applied',
    },
  },
  none: {
    fileRead: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: SANDBOX_SEAM_REF,
      note: 'danger-full-access or no sandbox: no confinement by explicit semantics',
    },
    fileWrite: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: SANDBOX_SEAM_REF,
      note: 'danger-full-access or no sandbox: no confinement by explicit semantics',
    },
    netEgress: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: SANDBOX_SEAM_REF,
      note: 'no confinement applies',
    },
    resourceLimits: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: SANDBOX_SEAM_REF,
      note: 'no confinement applies',
    },
    processControl: {
      status: 'absent',
      evidence: 'static-config',
      evidenceRef: SANDBOX_SEAM_REF,
      note: 'no confinement applies',
    },
  },
}
