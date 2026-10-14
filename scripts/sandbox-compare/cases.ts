/**
 * Case definitions. Each case states its ideal security outcome and the
 * evidence class that decides it; whether a subject passes depends on what
 * the outside world observed, so a subject without a mechanism fails openly
 * (a real gap) instead of being silently skipped.
 */

import type { CompareCase, SubjectId } from './schema.ts'

const ALL_SANDBOXES: readonly SubjectId[] = ['DSH-BASE', 'DSH-PLUGIN', 'SRT', 'NSJAIL']
const DSH_ONLY: readonly SubjectId[] = ['DSH-BASE', 'DSH-PLUGIN']
const DSH_PLUGIN_ONLY: readonly SubjectId[] = ['DSH-PLUGIN']

export interface CaseContext {
  readonly workspace: string
  readonly outside: string
  readonly sensitive: string
  readonly allowUrl: string
  readonly denyUrl: string
  readonly canary: string
  readonly port: number
}

export function renderTemplate(template: string, context: CaseContext): string {
  return template
    .replaceAll('{WORKSPACE}', context.workspace)
    .replaceAll('{OUTSIDE}', context.outside)
    .replaceAll('{SENSITIVE}', context.sensitive)
    .replaceAll('{ALLOW_URL}', context.allowUrl)
    .replaceAll('{DENY_URL}', context.denyUrl)
    .replaceAll('{CANARY}', context.canary)
    .replaceAll('{PORT}', String(context.port))
}

const FS_OUTSIDE_WRITE = 'printf {CANARY} > {OUTSIDE}/escape-{CANARY}.txt'
const NET_DENY_CURL = 'curl -sS --max-time 5 {DENY_URL} -d {CANARY} || true'

export const CASES: readonly CompareCase[] = [
  {
    id: 'FS-01',
    category: 'fs',
    description: 'create and read a file inside the workspace (positive control)',
    profile: 'P1-WORKSPACE-WRITE',
    expectation: 'succeeds',
    action: { kind: 'shell', command: 'printf {CANARY} > {WORKSPACE}/inside.txt && cat {WORKSPACE}/inside.txt' },
    blockedEvidence: 'file-must-not-exist',
    successEvidence: 'file-exists',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'FS-02',
    category: 'fs',
    description: 'create a file outside the workspace',
    profile: 'P1-WORKSPACE-WRITE',
    expectation: 'blocked',
    action: { kind: 'shell', command: FS_OUTSIDE_WRITE },
    blockedEvidence: 'file-must-not-exist',
    successEvidence: 'file-exists',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'FS-03',
    category: 'fs',
    description: 'overwrite an existing file outside the workspace',
    profile: 'P1-WORKSPACE-WRITE',
    expectation: 'blocked',
    action: { kind: 'shell', command: 'printf hacked > {OUTSIDE}/existing.txt' },
    blockedEvidence: 'file-content-unchanged',
    successEvidence: 'file-exists',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'FS-04',
    category: 'fs',
    description: 'delete a file outside the workspace',
    profile: 'P1-WORKSPACE-WRITE',
    expectation: 'blocked',
    action: { kind: 'shell', command: 'rm -f {OUTSIDE}/victim.txt' },
    blockedEvidence: 'file-content-unchanged',
    successEvidence: 'file-exists',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'FS-05',
    category: 'fs',
    description: 'traversal with .. segments escapes via the workspace path',
    profile: 'P1-WORKSPACE-WRITE',
    expectation: 'blocked',
    action: { kind: 'shell', command: 'printf hacked > {WORKSPACE}/../traversal-{CANARY}.txt' },
    blockedEvidence: 'file-must-not-exist',
    successEvidence: 'file-exists',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'FS-06',
    category: 'fs',
    description: 'symlink inside the workspace pointing at a file outside it, then write through it',
    profile: 'P1-WORKSPACE-WRITE',
    expectation: 'blocked',
    action: { kind: 'shell', command: 'ln -s {OUTSIDE}/existing.txt {WORKSPACE}/link.lnk && printf hacked > {WORKSPACE}/link.lnk' },
    blockedEvidence: 'file-content-unchanged',
    successEvidence: 'file-exists',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'FS-10',
    category: 'fs',
    description: 'read a normal workspace file under read-only (positive control)',
    profile: 'P0-READONLY',
    expectation: 'succeeds',
    action: { kind: 'shell', command: 'cat {WORKSPACE}/readable.txt' },
    blockedEvidence: 'file-must-not-exist',
    successEvidence: 'file-exists',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'FS-11',
    category: 'fs',
    description: 'read a synthetic sensitive file (synthetic .pem fixture under the synthetic home)',
    profile: 'P2-DENY-READ',
    expectation: 'blocked',
    action: { kind: 'shell', command: 'cat {SENSITIVE}/synthetic-key.pem' },
    blockedEvidence: 'error-message',
    successEvidence: 'file-exists',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'FS-12',
    category: 'fs',
    description: 'symlink alias pointing at the synthetic sensitive file',
    profile: 'P2-DENY-READ',
    expectation: 'blocked',
    action: { kind: 'shell', command: 'ln -s {SENSITIVE}/synthetic-key.pem {WORKSPACE}/alias.pem && cat {WORKSPACE}/alias.pem' },
    blockedEvidence: 'error-message',
    successEvidence: 'file-exists',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'NET-01',
    category: 'net',
    description: 'request the allowlisted test endpoint (positive control)',
    profile: 'P3-NET-ALLOWLIST',
    expectation: 'succeeds',
    action: { kind: 'shell', command: 'curl -sS --max-time 5 {ALLOW_URL} -d {CANARY} || true' },
    blockedEvidence: 'no-server-request',
    successEvidence: 'server-request-received',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'NET-02',
    category: 'net',
    description: 'request the non-allowlisted test endpoint',
    profile: 'P3-NET-ALLOWLIST',
    expectation: 'blocked',
    action: { kind: 'shell', command: NET_DENY_CURL },
    blockedEvidence: 'no-server-request',
    successEvidence: 'server-request-received',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'NET-03',
    category: 'net',
    description: 'strip proxy environment variables, then connect directly',
    profile: 'P3-NET-ALLOWLIST',
    expectation: 'blocked',
    action: { kind: 'shell', command: 'env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy curl -sS --max-time 5 {DENY_URL} -d {CANARY} || true' },
    blockedEvidence: 'no-server-request',
    successEvidence: 'server-request-received',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'NET-04',
    category: 'net',
    description: 'connect by raw IP instead of hostname (allowlist bypass attempt)',
    profile: 'P3-NET-ALLOWLIST',
    expectation: 'blocked',
    action: { kind: 'shell', command: 'curl -sS --max-time 5 "http://127.0.0.1:{PORT}/probe" -d {CANARY} -H "Host: hourglass-deny.tests.local" || true' },
    blockedEvidence: 'no-server-request',
    successEvidence: 'server-request-received',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'NET-05',
    category: 'net',
    description: 'Node native net client (ignores proxy environment entirely)',
    profile: 'P3-NET-ALLOWLIST',
    expectation: 'blocked',
    action: { kind: 'shell', command: 'node -e "const net=require(\'node:net\');const s=net.connect({host:\'127.0.0.1\',port:Number(process.env.HG_PORT)},()=>{s.write(\'POST /probe HTTP/1.1\\r\\nHost: hourglass-deny.tests.local\\r\\nContent-Length: \'+process.env.HG_CANARY.length+\'\\r\\n\\r\\n\'+process.env.HG_CANARY)});s.on(\'error\',()=>process.exit(0));setTimeout(()=>process.exit(0),4000)"' },
    blockedEvidence: 'no-server-request',
    successEvidence: 'server-request-received',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'NET-06',
    category: 'net',
    description: 'subprocess of the sandboxed shell makes the denied request',
    profile: 'P3-NET-ALLOWLIST',
    expectation: 'blocked',
    action: { kind: 'shell', command: 'bash -c \'curl -sS --max-time 5 {DENY_URL} -d {CANARY} || true\'' },
    blockedEvidence: 'no-server-request',
    successEvidence: 'server-request-received',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'NET-10',
    category: 'net',
    description: 'reverse test: an empty allowlist must default to deny, not allow-all',
    profile: 'P3-NET-ALLOWLIST',
    expectation: 'blocked',
    action: { kind: 'shell', command: NET_DENY_CURL },
    blockedEvidence: 'no-server-request',
    successEvidence: 'server-request-received',
    appliesTo: ALL_SANDBOXES,
  },
  {
    id: 'ROB-01',
    category: 'rob',
    description: 'sandbox runner unavailable must fail closed, never pass through',
    profile: 'P5-FAIL-CLOSED',
    expectation: 'blocked',
    action: { kind: 'shell', command: 'printf should-not-run > {WORKSPACE}/rob01.txt' },
    blockedEvidence: 'file-must-not-exist',
    successEvidence: 'error-message',
    appliesTo: DSH_ONLY,
  },
  {
    id: 'AUD-02',
    category: 'aud',
    description: 'audit ledger classifies policy deny, sandbox denial, runner failure, and ordinary failure distinctly',
    profile: 'P1-WORKSPACE-WRITE',
    expectation: 'blocked',
    action: { kind: 'shell', command: 'printf {CANARY} > {OUTSIDE}/aud02.txt' },
    blockedEvidence: 'file-must-not-exist',
    successEvidence: 'audit-records',
    appliesTo: DSH_PLUGIN_ONLY,
  },
  {
    id: 'AUD-11',
    category: 'aud',
    description: 'denial event sources are not confused: backend denial carries result.sandbox facts, not just stderr',
    profile: 'P1-WORKSPACE-WRITE',
    expectation: 'blocked',
    action: { kind: 'shell', command: 'printf {CANARY} > {OUTSIDE}/aud11.txt' },
    blockedEvidence: 'file-must-not-exist',
    successEvidence: 'audit-records',
    appliesTo: DSH_PLUGIN_ONLY,
  },
]
