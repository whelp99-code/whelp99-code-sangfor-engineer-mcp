/** Remove only the observed support crawler chrome after reconstructing a document. */
export function stripSupportChrome(text: string): string {
  if (!/^# .+\n/.test(text) || !text.includes('Documents Best Practices Cases Softwares')) return text;
  const marker = /Read Permission:Guest Download Share \| Favorite Updated On:\s*\[REDACTED_PHONE\]\s*/.exec(text);
  if (!marker) return text;
  const title = text.slice(0, text.indexOf('\n'));
  const body = text.slice(marker.index + marker[0].length);
  const footer = body.indexOf('This documentation helps me solve problems easily. If your issue is not resolved, you can ask Online Support for help.');
  const content = (footer < 0 ? body : body.slice(0, footer)).trim();
  return content ? `${title}\n\n${content}` : text;
}

/** Reassemble only byte-identical adjacent overlap. Unknown gaps remain explicit. */
export function joinOverlappingChunks(chunks: readonly string[]): string {
  let result = chunks[0] ?? '';
  for (const chunk of chunks.slice(1)) {
    let overlap = 0;
    for (let size = Math.min(result.length, chunk.length, 4096); size >= 32; size--) {
      if (result.endsWith(chunk.slice(0, size))) { overlap = size; break; }
    }
    result += overlap ? chunk.slice(overlap) : `\n\n${chunk}`;
  }
  return result;
}

/** Keep tables/fences atomic and carry the current heading into subsequent passages. */
export function structuredChunks(text: string, maxChars = 1800): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 128) throw new Error('RAG_CHUNK_SIZE_INVALID');
  const blocks: string[] = [];
  let block: string[] = [];
  let fence: string | undefined;
  let table = false;
  const flush = () => { if (block.length) blocks.push(block.join('\n')); block = []; };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const boundary = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      block.push(line);
      if (boundary && boundary[1][0] === fence[0] && boundary[1].length >= fence.length) { fence = undefined; flush(); }
    } else if (boundary) { flush(); table = false; fence = boundary[1]; block.push(line); }
    else if (/^\s*\|/.test(line)) { if (!table) flush(); table = true; block.push(line); }
    else {
      if (table) { flush(); table = false; }
      if (!line.trim()) flush();
      else if (/^#{1,6}\s/.test(line)) { flush(); blocks.push(line); }
      else block.push(line);
    }
  }
  flush();
  const result: string[] = [];
  let heading = '';
  let current = '';
  const emit = () => { if (current.trim() && current !== heading) result.push(current.trim()); current = ''; };
  for (const value of blocks) {
    if (/^#{1,6}\s/.test(value)) { emit(); heading = value; current = value; continue; }
    const atomic = /^\s*(?:\||`{3,}|~{3,})/.test(value);
    let rest = value;
    while (rest.length) {
      const budget = Math.max(1, maxChars - heading.length - 2);
      let cut = rest.length;
      if (!atomic && cut > budget) {
        cut = rest.lastIndexOf(' ', budget);
        if (cut < budget / 2) cut = budget;
      }
      const part = rest.slice(0, cut);
      if (current && current.length + part.length + 2 > maxChars) emit();
      if (!current) current = heading;
      current += `${current ? '\n\n' : ''}${part}`;
      rest = rest.slice(cut).trimStart();
      if (rest.length || atomic) emit();
    }
  }
  emit();
  return result.length ? result : (heading ? [heading] : []);
}
