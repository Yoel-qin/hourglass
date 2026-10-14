/**
 * Confine decoration: turn a bwrap wrap into a network-isolated wrap.
 *
 * The bwrap argument list gains --unshare-net (kernel-level refusal of every
 * direct connection), read-only binds for the proxy socket, the in-sandbox
 * TCP→unix bridge, and the launcher that exports the proxy environment and
 * supervises the bridge. Non-bwrap wraps cannot express network isolation,
 * so under a restrictive policy confine fails closed instead of passing
 * traffic through.
 * @module @hourglass/sandbox-net
 */

import { SANDBOX_UNAVAILABLE, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'

/**
 * Paths fixed inside the sandbox (bind targets). They live under /tmp because
 * the workspace-write bwrap profile mounts an ephemeral tmpfs there — the
 * read-only root cannot host new mount points. The net plugin therefore
 * requires a wrap whose /tmp is writable (DSH workspace-write provides it).
 */
export const IN_SANDBOX_DIR = '/tmp/.hourglass'
export const IN_SANDBOX_PROXY_SOCK = `${IN_SANDBOX_DIR}/proxy.sock`
export const IN_SANDBOX_BRIDGE = `${IN_SANDBOX_DIR}/bridge.mjs`
export const IN_SANDBOX_LAUNCHER = `${IN_SANDBOX_DIR}/launch.sh`
/** Port the in-sandbox bridge listens on (loopback of the isolated netns). */
export const BRIDGE_PORT = 3128
/** Ready marker on the ephemeral tmpfs (not inside the read-only bind dir). */
export const IN_SANDBOX_READY = '/tmp/.hourglass-ready'

/** The launcher exported environment: proxy variables for every client kind. */
export function launcherScript(): string {
  const proxyUrl = `http://127.0.0.1:${BRIDGE_PORT}`
  return [
    '#!/bin/sh',
    `export HTTP_PROXY=${proxyUrl} http_proxy=${proxyUrl}`,
    `export HTTPS_PROXY=${proxyUrl} https_proxy=${proxyUrl}`,
    'export NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1',
    `node ${IN_SANDBOX_BRIDGE} &`,
    'BRIDGE_PID=$!',
    '# Wait for the bridge to listen (it writes a ready marker), bounded so a',
    '# dead bridge fails the command quickly instead of hanging forever.',
    'i=0',
    `while [ ! -f ${IN_SANDBOX_READY} ] && [ "$i" -lt 40 ]; do`,
    '  sleep 0.05',
    '  i=$((i + 1))',
    'done',
    "trap 'kill $BRIDGE_PID 2>/dev/null' EXIT INT TERM",
    'exec "$@"',
    '',
  ].join('\n')
}

/** The in-sandbox bridge: loopback TCP → the bind-mounted proxy unix socket. */
export function bridgeScript(): string {
  return [
    "import { connect, createServer } from 'node:net'",
    "import { writeFileSync } from 'node:fs'",
    `const server = createServer(socket => {`,
    `  const upstream = connect(${JSON.stringify(IN_SANDBOX_PROXY_SOCK)})`,
    '  socket.pipe(upstream)',
    '  upstream.pipe(socket)',
    "  const drop = () => { socket.destroy(); upstream.destroy() }",
    "  socket.on('error', drop)",
    "  upstream.on('error', drop)",
    '})',
    `server.listen(${BRIDGE_PORT}, '127.0.0.1', () => {`,
    `  writeFileSync(${JSON.stringify(IN_SANDBOX_READY)}, 'ok')`,
    '})',
    'setInterval(() => {}, 3600_000)',
    '',
  ].join('\n')
}

export interface NetworkWrapOptions {
  /** Host-side path of the running egress proxy's unix socket. */
  readonly proxySocketPath: string
  /** Host-side path of the bridge script to bind-mount. */
  readonly bridgePath: string
  /** Host-side path of the launcher script to bind-mount. */
  readonly launcherPath: string
}

/** True when the wrapped argv is a bubblewrap launch (the only enforceable rung). */
export function isBwrapArgv(argv: readonly string[]): boolean {
  return argv.length > 0 && argv[0] === 'bwrap'
}

/**
 * Rewrite one confined argv for network isolation. Throws
 * SandboxUnavailableError when the wrap cannot be isolated (non-bwrap rung)
 * — never a silent passthrough.
 */
export function wrapConfinedForNetwork(confined: ConfinedArgv, options: NetworkWrapOptions): ConfinedArgv {
  if (!isBwrapArgv(confined.argv)) {
    throw new SandboxUnavailableError(
      `network egress policy cannot be enforced on a non-bwrap rung (argv0=${JSON.stringify(confined.argv[0])}); refusing to run unconfined`,
    )
  }
  const separator = confined.argv.indexOf('--')
  if (separator < 0) {
    throw new SandboxUnavailableError('network egress policy: bwrap argv has no "--" separator; refusing to guess')
  }
  const bwrapArgs = confined.argv.slice(0, separator)
  const command = confined.argv.slice(separator + 1)
  const argv = [
    ...bwrapArgs,
    // /tmp is an ephemeral tmpfs under workspace-write; create the mount
    // point there (the read-only root cannot host one).
    '--dir', IN_SANDBOX_DIR,
    '--unshare-net',
    '--ro-bind', options.proxySocketPath, IN_SANDBOX_PROXY_SOCK,
    '--ro-bind', options.bridgePath, IN_SANDBOX_BRIDGE,
    '--ro-bind', options.launcherPath, IN_SANDBOX_LAUNCHER,
    '--',
    '/bin/sh', IN_SANDBOX_LAUNCHER,
    ...command,
  ]
  return { ...confined, argv }
}

export { SANDBOX_UNAVAILABLE, SandboxUnavailableError }
