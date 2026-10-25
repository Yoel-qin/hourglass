// Minimal nightly-drill concurrency-phase helper.
import { readFileSync } from 'node:fs'

// Reads a worker's marker file. A worker that crashed before writing its
// marker yields undefined — the drill must still produce its report, never
// crash on the missing file.
export function readMarker(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return undefined
  }
}
