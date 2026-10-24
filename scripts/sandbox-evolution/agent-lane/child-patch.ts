/**
 * Pure builder for the agent-lane child's one-shot profile patch (ADR-004 D1,
 * P3/P4 evidence carriers). The patch is applied by subagent-dsh-sdk to the
 * child's `sdk` profile per launch (a `--patch` overlay) and never reused
 * across trials:
 *
 *  - the official DeepSeek route is re-pointed at the host-side LLM broker
 *    (credentials stay host-side; the child carries only a dummy key the
 *    broker strips — D2 boundary);
 *  - the child agent's cwd is the task workspace;
 *  - skills load ONLY from the content-addressed candidate snapshot
 *    (includeDefaultRoots: false);
 *  - session journals stay plain JSONL (compression: none) so evidence is
 *    readable without zstd tooling;
 *  - the governance plugins mount via `- insert:` with RELATIVE SOURCE paths
 *    resolved against this patch file's location — the child profile
 *    composes npm bundles only, so bare @hourglass package names would not
 *    resolve (the desktop `- insert:` lesson, adapted for the SDK child).
 *
 * @module @hourglass/evolution-runner
 */

export interface ChildPatchOptions {
  /** Broker loopback base, e.g. http://127.0.0.1:39129 (no /v1 suffix). */
  readonly brokerBaseUrl: string
  /** Child route model id (locked in the lane config; e.g. deepseek-flash). */
  readonly modelId: string
  /** Task workspace the child agent runs in. */
  readonly workspace: string
  /** Child-side audit ledger path (strict mode — write failure fails the run). */
  readonly ledgerPath: string
  /** Net decision log path (JSONL, alongside the ledger). */
  readonly netDecisionLog: string
  readonly netMode: 'allowlist' | 'deny-all'
  readonly netAllowlist: readonly string[]
  /** DIRECTORIES masked by deny-read (tmpfs cannot mount over single files). */
  readonly readDenyDirs: readonly string[]
  /** Content-addressed skill snapshot roots (the only skill sources). */
  readonly skillDirs: readonly string[]
  /** The child's DSH home (required by skill-filesystem's config schema). */
  readonly childHome: string
  /**
   * Debugging bisect: which sections to emit. Default 'full'; 'llm-only'
   * emits just the model-route override (used to isolate composition
   * failures section by section).
   */
  readonly variant?: 'full' | 'llm-only' | 'trivial-insert'
}

function yamlList(values: readonly string[], indent: string): string {
  return values.map(value => `${indent}- ${JSON.stringify(value)}`).join('\n')
}

/** Build the child patch YAML text (deterministic; no YAML dependency). */
export function buildChildPatchYaml(options: ChildPatchOptions): string {
  // The profile's loader only accepts './'-relative sources (…-relative
  // names break composition), so the probe writes one-line re-export shims
  // next to the patch file and the patch references those.
  const plugin = (shim: string): string => `'./${shim}'`
  const lines: string[] = [
    '# hourglass agent-lane child patch (generated per trial; do not edit)',
    '- id: llm-deepseek',
    '  name: \'@deepseek-ai/dsh-llm-deepseek-api-key\'',
    '  config:',
    `    baseURL: ${JSON.stringify(options.brokerBaseUrl)}`,
    // apiKeyEnv stays at its default DEEPSEEK_API_KEY (the volatile
    // credential-ref field does not accept patch overrides); the probe
    // satisfies it with a dummy value — the broker strips client
    // credentials and injects the real upstream key.
    '- id: agent-loop',
    '  config:',
    '    agents:',
    '      - id: main',
    '        provider: deepseek-official',
    `        model: ${JSON.stringify(options.modelId)}`,
    `        cwd: ${JSON.stringify(options.workspace)}`,
    '- id: skill-filesystem',
    '  config:',
    '    includeDefaultRoots: false',
    '    watch: true',
    `    dshHome: ${JSON.stringify(options.childHome)}`,
    `    agentsHome: ${JSON.stringify(options.childHome)}`,
  ]
  if (options.variant === 'llm-only') return `${lines.join('\n')}\n`
  // The trial child is headless: nobody can answer an 'ask' approval, and a
  // pending approval would fail the turn. Two entries change together: the
  // approval plugin's policy AND the matching preset row (the permission
  // service requires the composed sandbox+approval pair to match a preset).
  // The DSH sandbox itself stays workspace-write, so confinement (hourglass
  // net/read) still applies to every command.
  lines.push('- id: approval')
  lines.push('  config:')
  lines.push('    policy: never')
  lines.push('- id: permission')
  lines.push('  config:')
  lines.push('    presets:')
  lines.push('      read-only:')
  lines.push('        sandbox: read-only')
  lines.push('        approval: ask')
  lines.push('      workspace-write:')
  lines.push('        sandbox: workspace-write')
  lines.push('        approval: never')
  lines.push('      danger-full-access:')
  lines.push('        sandbox: danger-full-access')
  lines.push('        approval: never')
  if (options.variant === 'trivial-insert') {
    return `${[
      ...lines,
      '- insert:',
      "    - id: trivial-probe",
      "      name: './trivial.ts'",
    ].join('\n')}\n`
  }
  // No filesystem skill roots at all: the candidate enters via the
  // candidate-skill shim's runtime ctx.skills.register (see shim-skill.ts) —
  // custom roots list through the child's ctx.fs (blind to host paths) and
  // the loader's config merge drops bundledSkillDir.
  lines.push('- insert:')
  lines.push("    - id: skill-dump")
  lines.push("      name: './shim-skill.ts'")
  lines.push('    - id: hourglass-audit')
  lines.push(`      name: ${plugin('shim-audit.ts')}`)
  lines.push('      config:')
  lines.push(`        ledgerPath: ${JSON.stringify(options.ledgerPath)}`)
  lines.push('        strict: true')
  lines.push('    - id: hourglass-net')
  lines.push(`      name: ${plugin('shim-net.ts')}`)
  lines.push('      config:')
  lines.push(`        mode: ${JSON.stringify(options.netMode)}`)
  lines.push(`        decisionLog: ${JSON.stringify(options.netDecisionLog)}`)
  if (options.netAllowlist.length > 0) {
    lines.push('        allowlist:')
    lines.push(yamlList(options.netAllowlist, '        '))
  }
  if (options.readDenyDirs.length > 0) {
    lines.push('    - id: hourglass-read')
    lines.push(`      name: ${plugin('shim-read.ts')}`)
    lines.push('      config:')
    lines.push('        denyRead:')
    lines.push(yamlList(options.readDenyDirs, '        '))
  }
  return `${lines.join('\n')}\n`
}
