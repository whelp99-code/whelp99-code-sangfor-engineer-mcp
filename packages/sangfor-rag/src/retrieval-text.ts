/** Conservative search view. Never rewrites persisted source documents. */
export function cleanRetrievalText(text: string): string {
  let value = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const frontmatter = value.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (frontmatter && /^sourceUrl:\s*https?:\/\//m.test(frontmatter[1])
    && /^contentHash:\s*[a-f0-9]{64}\s*$/m.test(frontmatter[1])) {
    value = value.slice(frontmatter[0].length);
  }
  // Only the exact crawler navigation prefix, outside fenced code. Do not strip
  // a whole line: this crawler often flattens navigation and body onto one line.
  let fenced = false;
  return value.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return line;
    return line.replace(/^Community Partner e-Learning Official Site Partner One English Sangfor Support Home Products Troubleshooting Cases Best Practices Software Download Service Hub Log in My Sangfor\s*/, '');
  }).join('\n').trim();
}

/** A single explicit release in a manual heading; no guessing from body text. */
export function documentVersionFromTitle(title: string): string | undefined {
  const matches = [...title.matchAll(/(?<![\w.])(\d+\.\d+\.\d+(?:R\d+)?)(?=\s+-\s+)/gi)].map((match) => match[1]);
  return new Set(matches).size === 1 ? matches[0] : undefined;
}

/** The most specific breadcrumb is scored separately from the body. */
export function retrievalTitle(title: string): string {
  return title.split(/\s+\/\s+/).at(-1)?.trim() || title;
}

/** Ancestors excluding the document root and separately scored leaf heading. */
export function retrievalAncestors(title: string): string {
  return title.split(/\s+\/\s+/).slice(1, -1).map((part) => part.trim()).join(' / ');
}

export function selectRetrievalSnippet(query: string, text: string, maxChars = 1200): string {
  const cleaned = cleanRetrievalText(text);
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9가-힣]{2,}/g) ?? [])];
  if (cleaned.length <= maxChars) return cleaned;
  let bestStart = 0;
  let bestScore = -1;
  // Overlapping windows preserve the text around matches, rather than stitching
  // unrelated sentences together or presenting a generated "answer" as evidence.
  const stride = Math.max(1, Math.floor(maxChars / 2));
  for (let start = 0; start < cleaned.length; start += stride) {
    const window = cleaned.slice(start, start + maxChars).toLowerCase();
    const score = terms.filter((term) => window.includes(term)).length;
    if (score > bestScore) { bestScore = score; bestStart = start; }
  }
  return cleaned.slice(bestStart, bestStart + maxChars);
}

/** The heading has its own scoring field; do not count it again as body evidence. */
export function retrievalBody(text: string, title: string): string {
  const cleaned = cleanRetrievalText(text);
  const newline = cleaned.indexOf('\n');
  const firstLine = newline < 0 ? cleaned : cleaned.slice(0, newline);
  return firstLine.trim() === `# ${title}` ? (newline < 0 ? '' : cleaned.slice(newline + 1).trim()) : cleaned;
}
