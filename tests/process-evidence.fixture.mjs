// Dependency-free reader for the child-process evidence journal (process-evidence.jsonl).
// Each record is appended as one `JSON\n` line. Bytes after the last newline are a write
// still in progress, or a record truncated by a killed writer; they are not evidence yet and
// are skipped, so the next read sees them once complete. Every complete line must still
// parse: a malformed complete record throws and is never skipped.
export function parseCompleteProcessEvidence(text) {
  const completeLength = text.lastIndexOf('\n') + 1
  return text
    .slice(0, completeLength)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
