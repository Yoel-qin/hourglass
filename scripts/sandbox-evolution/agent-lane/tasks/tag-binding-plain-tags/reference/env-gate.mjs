// Environment fingerprint gate, minimal extraction. The pinned sha comes
// from the lock. An installed tree reports its HEAD sha plus the tag names
// pointing at HEAD — container images materialize a fresh commit and tag it
// with the upstream sha, while plain checkouts may also carry ordinary
// version tags. The gate matches when the HEAD sha equals the pinned sha OR
// a tag pointing at HEAD carries exactly that pinned sha; anything else
// (including an unreadable tree) is a mismatch.
export function environmentMatches(tree, pinnedSha) {
  return tree.headSha === pinnedSha || tree.tags.includes(pinnedSha)
}
