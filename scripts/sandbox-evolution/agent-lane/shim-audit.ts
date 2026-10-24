// Loader shim for the agent-lane child patch: the profile loader accepts
// only './'-relative plugin sources, resolved against the patch file's
// directory (this one). Absolute re-export of the verified hourglass plugin
// source from the fused image layout.
export * from '/opt/dsh/packages/hourglass/audit/src/index.ts'
