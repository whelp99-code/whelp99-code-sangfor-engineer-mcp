import { COMMUNITY_BASE } from './site-learning-types.js';

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function numericMatches(html: string, patterns: RegExp[]): number[] {
  const values = patterns.flatMap((pattern) =>
    [...html.matchAll(pattern)].map((match) => Number(match[1])));
  return [...new Set(values.filter(Number.isInteger))].sort((left, right) => left - right);
}

export function extractCommunityForumIds(html: string): number[] {
  return numericMatches(html, [
    /forum\.php\?[^"'<>]*\bfid=(\d+)/gi,
    /forum-(\d+)-\d+\.html/gi,
  ]);
}

export function extractCommunityThreadIds(html: string): number[] {
  return numericMatches(html, [
    /forum\.php\?[^"'<>]*\btid=(\d+)/gi,
    /thread-(\d+)-\d+-\d+\.html/gi,
  ]);
}

export function parseCommunityThreadPage(html: string): { title: string; text: string } | null {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripHtml(titleMatch?.[1] ?? 'Sangfor Community thread');
  const bodyPattern = /<(?:td|div)[^>]*(?:class=["'][^"']*\bt_f\b[^"']*["'][^>]*id=["']postmessage_\d+["']|id=["']postmessage_\d+["'][^>]*class=["'][^"']*\bt_f\b[^"']*["'])[^>]*>([\s\S]*?)<\/(?:td|div)>/gi;
  const bodies = [...html.matchAll(bodyPattern)]
    .map((match) => stripHtml(match[1]))
    .filter((body) => body.length > 0);
  if (bodies.length > 0) return { title, text: bodies.join('\n\n') };

  const postlistDataStart = html.indexOf("postlistData'");
  const jsonScope = postlistDataStart >= 0 ? html.slice(postlistDataStart) : '';
  const jsonBodies = [...jsonScope.matchAll(/"message":"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => {
      try {
        return stripHtml(JSON.parse(`"${match[1]}"`));
      } catch {
        return '';
      }
    })
    .filter((body) => body.length > 0);
  if (jsonBodies.length === 0) return null;
  return { title, text: jsonBodies.join('\n\n') };
}

export function parseRobotsDisallowRules(text: string): string[] {
  const rules: string[] = [];
  let applies = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawName, ...rawValue] = line.split(':');
    const name = rawName.trim().toLowerCase();
    const value = rawValue.join(':').trim();
    if (name === 'user-agent') {
      applies = value === '*';
    } else if (name === 'disallow' && applies && value) {
      rules.push(value);
    }
  }
  return rules;
}

export function isUrlAllowedByRobots(rawUrl: string, disallowRules: string[]): boolean {
  const url = new URL(rawUrl);
  const pathAndQuery = `${url.pathname}${url.search}`;
  return !disallowRules.some((rule) => {
    const anchored = rule.endsWith('$');
    const body = anchored ? rule.slice(0, -1) : rule;
    const source = body
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${source}${anchored ? '$' : ''}`).test(pathAndQuery);
  });
}

export function extractCommunityPageCount(html: string): number {
  const pages = numericMatches(html, [
    /[?&](?:amp;)?page=(\d+)/gi,
    /(?:forum|thread)-\d+-(\d+)(?:-\d+)?\.html/gi,
  ]);
  return Math.max(1, ...pages);
}

function scopedDiscuzPageCount(
  html: string,
  mode: 'forumdisplay' | 'viewthread',
  idName: 'fid' | 'tid',
  id: number,
): number {
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)]
    .map((match) => match[1].replace(/&amp;/g, '&'));
  const pages = hrefs.flatMap((href) => {
    try {
      const url = new URL(href, COMMUNITY_BASE);
      if (url.pathname !== '/forum.php') return [];
      if (url.searchParams.get('mod') !== mode) return [];
      if (Number(url.searchParams.get(idName)) !== id) return [];
      const page = Number(url.searchParams.get('page') ?? 1);
      return Number.isSafeInteger(page) && page > 0 ? [page] : [];
    } catch {
      return [];
    }
  });
  return Math.max(1, ...pages);
}

export function extractCommunityForumPageCount(html: string, forumId: number): number {
  const prettyPages = [...html.matchAll(new RegExp(`forum-${forumId}-(\\d+)\\.html`, 'gi'))]
    .map((match) => Number(match[1]))
    .filter((page) => Number.isSafeInteger(page) && page > 0);
  return Math.max(scopedDiscuzPageCount(html, 'forumdisplay', 'fid', forumId), ...prettyPages);
}

export function extractCommunityThreadPageCount(html: string, threadId: number): number {
  const prettyPages = [...html.matchAll(new RegExp(`thread-${threadId}-(\\d+)-\\d+\\.html`, 'gi'))]
    .map((match) => Number(match[1]))
    .filter((page) => Number.isSafeInteger(page) && page > 0);
  return Math.max(scopedDiscuzPageCount(html, 'viewthread', 'tid', threadId), ...prettyPages);
}
