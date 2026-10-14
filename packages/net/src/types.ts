/**
 * Network-egress policy vocabulary for @hourglass/sandbox-net.
 *
 * The two-layer model follows the plan's P2a requirement: the OS layer
 * (bwrap --unshare-net) blocks every direct connection; the policy layer
 * (host-side allowlist proxy) is the ONLY way out. `enforced` for netEgress
 * requires both layers to be proven by real tests.
 * @module @hourglass/sandbox-net
 */

/** Policy mode. An empty allowlist under `allowlist` mode means deny-all. */
export type NetEgressMode = 'deny-all' | 'allowlist' | 'unrestricted'

export interface NetEgressPolicy {
  readonly mode: NetEgressMode
  readonly allowlist: readonly string[]
}

/** One proxy decision, appended to the decision log (audit trail). */
export interface ProxyDecision {
  readonly at: string
  readonly kind: 'connect' | 'absolute-uri'
  readonly host: string
  readonly port?: number
  readonly allowed: boolean
  readonly reason: string
}

/** Static knowledge about what each layer of this design provides. */
export const NET_EGRESS_FACTS = {
  osLayer: 'bwrap --unshare-net: the sandbox owns an isolated network namespace; every direct connection (IP, port, protocol) is refused by the kernel',
  policyLayer: 'host-side allowlist proxy over a bind-mounted unix socket; hostname normalization and suffix-subdomain matching come from @hourglass/policy-ci',
  nonHttpNote: 'raw TCP and non-HTTP protocols have no proxy path and are blocked by the OS layer (reported as enforced-block, not as a proxy denial)',
} as const
