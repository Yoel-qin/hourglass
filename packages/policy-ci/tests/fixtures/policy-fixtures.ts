/**
 * Synthetic, frozen policy fixtures (POL-07). Every path and host below is a
 * made-up constant — no recorded sessions, user material, or real secrets.
 * The workspace root is synthetic too; the replay never touches a filesystem.
 */

import type { PolicyFixture } from '../../src/types.ts'

export const SYNTHETIC_WORKSPACE = '/synth/workspace'

/** The frozen baseline fixture set for golden replays. */
export const BASELINE_FIXTURES: readonly PolicyFixture[] = [
  {
    caseId: 'FS-B01',
    description: 'write inside the synthetic workspace under workspace-write',
    tool: 'fs',
    operation: { kind: 'fs-write', path: '/synth/workspace/src/new-file.ts' },
  },
  {
    caseId: 'FS-B02',
    description: 'write outside the workspace under workspace-write',
    tool: 'fs',
    operation: { kind: 'fs-write', path: '/synth/outside/escape.txt' },
  },
  {
    caseId: 'FS-B03',
    description: 'traversal attempt with .. segments resolves before containment',
    tool: 'fs',
    operation: { kind: 'fs-write', path: '/synth/workspace/../../etc/cron.d/x' },
  },
  {
    caseId: 'FS-B04',
    description: 'any write under read-only mode is denied',
    tool: 'fs',
    sandboxModeEvents: ['read-only'],
    operation: { kind: 'fs-write', path: '/synth/workspace/a.txt' },
  },
  {
    caseId: 'FS-B05',
    description: 'reads are unrestricted by base policy',
    tool: 'fs',
    operation: { kind: 'fs-read', path: '/synth/home/.ssh/synthetic-key' },
  },
  {
    caseId: 'FS-B06',
    description: 'delete outside the workspace under workspace-write',
    tool: 'fs',
    operation: { kind: 'fs-delete', path: '/synth/outside/victim.txt' },
  },
  {
    caseId: 'FS-B07',
    description: 'rename whose destination escapes the workspace',
    tool: 'fs',
    operation: { kind: 'fs-rename', from: '/synth/workspace/a.ts', to: '/synth/outside/b.ts' },
  },
  {
    caseId: 'NET-B01',
    description: 'network request under base policy (no net extension)',
    tool: 'web',
    operation: { kind: 'net-request', host: 'synthetic-allow.example' },
  },
  {
    caseId: 'NET-B02',
    description: 'IP-literal direct request under base policy',
    tool: 'web',
    operation: { kind: 'net-request', host: '203.0.113.7' },
  },
  {
    caseId: 'PROC-B01',
    description: 'subprocess spawn under confined modes',
    tool: 'bash',
    operation: { kind: 'spawn' },
  },
  {
    caseId: 'MODE-B01',
    description: 'session fold: last sandbox/mode event wins over configured',
    tool: 'bash',
    sandboxModeEvents: ['workspace-write', 'read-only'],
    operation: { kind: 'fs-write', path: '/synth/workspace/x.txt' },
  },
  {
    caseId: 'MODE-B02',
    description: 'approved escalation outranks the session fold',
    tool: 'bash',
    sandboxModeEvents: ['read-only'],
    approvedMode: 'workspace-write',
    operation: { kind: 'fs-write', path: '/synth/workspace/x.txt' },
  },
  {
    caseId: 'MODE-B03',
    description: 'danger-full-access allows everything by explicit semantics',
    tool: 'bash',
    approvedMode: 'danger-full-access',
    operation: { kind: 'fs-write', path: '/synth/outside/anywhere.txt' },
  },
]

/**
 * Host-normalization edge fixtures (NET-09 semantics, replayed at the policy
 * layer): each pair is an input host and the expectation after
 * normalization + allowlist matching against ['allow.example'].
 */
export const HOST_EDGE_CASES: readonly { input: string; normalized: string | undefined; allowed: boolean }[] = [
  { input: 'allow.example', normalized: 'allow.example', allowed: true },
  { input: 'ALLOW.Example', normalized: 'allow.example', allowed: true },
  { input: 'allow.example.', normalized: 'allow.example', allowed: true },
  { input: 'sub.allow.example', normalized: 'sub.allow.example', allowed: true },
  { input: 'deep.sub.allow.example', normalized: 'deep.sub.allow.example', allowed: true },
  { input: 'evil-allow.example', normalized: 'evil-allow.example', allowed: false },
  { input: 'allow.example.evil.net', normalized: 'allow.example.evil.net', allowed: false },
  { input: 'https://user@allow.example', normalized: undefined, allowed: false },
  { input: 'user@allow.example', normalized: 'allow.example', allowed: true },
  { input: 'allow\x00.example', normalized: undefined, allowed: false },
  { input: '203.0.113.256', normalized: undefined, allowed: false },
  { input: '[2001:db8::1]', normalized: '[2001:db8::1]', allowed: false },
  { input: '', normalized: undefined, allowed: false },
]
