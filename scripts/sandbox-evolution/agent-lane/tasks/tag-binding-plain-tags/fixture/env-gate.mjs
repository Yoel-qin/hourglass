// Environment fingerprint gate, minimal extraction. The pinned sha comes
// from the lock. An installed tree reports its HEAD sha plus the tag names
// pointing at HEAD — container images materialize a fresh commit and tag it
// with the upstream sha, while plain checkouts may also carry ordinary
// version tags.
export function environmentMatches(tree, pinnedSha) {
  let installed
  if (tree.tags.length > 0) {
    installed = tree.tags[0]
  } else {
    installed = tree.headSha
  }
  return installed === pinnedSha
}
