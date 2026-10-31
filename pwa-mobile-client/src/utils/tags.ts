/** A hashtag: `#` followed by letters, digits or `_`, not glued to a preceding word (so `a#b` is not a tag). */
const TAG_RE = /(^|[^\p{L}\p{N}_#])#([\p{L}\p{N}_]+)/gu

/** Canonical form used for matching: no leading `#`, lower case. "#Sport" and "sport" both become "sport". */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').toLowerCase()
}

/** Unique tags of a comment, normalized, in order of first appearance. */
export function extractTags(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(TAG_RE)) seen.add(normalizeTag(m[2]!))
  return [...seen]
}

export type CommentPart = { text: string; tag?: string }

/** Splits a comment into plain text and tag parts, so tags can be rendered as links. */
export function splitByTags(text: string): CommentPart[] {
  const parts: CommentPart[] = []
  let last = 0
  for (const m of text.matchAll(TAG_RE)) {
    const start = m.index! + m[1]!.length
    if (start > last) parts.push({ text: text.slice(last, start) })
    const raw = `#${m[2]}`
    parts.push({ text: raw, tag: normalizeTag(raw) })
    last = start + raw.length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}
