import type { ProductCode } from '@sangfor/shared';
import { normalizeProduct } from '@sangfor/shared';
import type { CollectedDocument } from './collector-types.js';

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function inferProductFromText(text: string, fallback: ProductCode = 'HCI'): ProductCode {
  const lower = text.toLowerCase();
  if (/\b(iag|swg|internet access gateway)\b/.test(lower)) return 'IAG';
  if (/\b(endpoint secure|epp|edr|aSec)\b/.test(lower)) return 'ENDPOINT_SECURE';
  if (/\b(ngfw|ngaf|athena ngfw|next-generation firewall)\b/.test(lower)) return 'NGFW';
  if (/\b(scc|sangfor data center cloud|data center cloud)\b/.test(lower)) return 'SCC';
  if (/\b(cyber command|ndr|xdr|mdr|soc)\b/.test(lower)) return 'CYBER_COMMAND';
  if (/\b(hci|hyper.?converged|aSV|vmware)\b/.test(lower)) return 'HCI';
  return normalizeProduct(text) !== 'HCI' || /\bhci\b/i.test(text) ? normalizeProduct(text) : fallback;
}

export function isCommunityNoise(title: string): boolean {
  const t = title.toLowerCase();
  return /honor award|daily q&a challenge|get coins|verify your account|rules and punishment|company profile/i.test(t);
}

export function parseCommunityThreadIds(html: string): number[] {
  const ids = new Set<number>();
  for (const match of html.matchAll(/mod=viewthread&amp;tid=(\d+)|mod=viewthread&tid=(\d+)/g)) {
    ids.add(Number(match[1] ?? match[2]));
  }
  return [...ids];
}

export function parseCommunityThread(
  html: string,
  threadId: number,
  sourceUrl: string,
): CollectedDocument | null {
  const titleMatch = html.match(/<span id="thread_subject">([^<]+)<\/span>/i)
    ?? html.match(/class="ts"[^>]*>([^<]+)</i);
  const title = htmlToText(titleMatch?.[1] ?? `Community thread ${threadId}`);
  if (isCommunityNoise(title)) return null;

  const postMatch = html.match(/<td[^>]*class="t_f"[^>]*id="postmessage_\d+"[^>]*>([\s\S]*?)<\/td>/i)
    ?? html.match(/id="postmessage_\d+"[^>]*>([\s\S]*?)<\/td>/i);
  if (!postMatch) return null;
  const body = htmlToText(postMatch[1]);
  if (body.length < 40) return null;

  return {
    id: `community_${threadId}`,
    source: 'community',
    sourceUrl,
    product: inferProductFromText(`${title}\n${body}`),
    title,
    text: `# ${title}\n\nSource: ${sourceUrl}\n\n${body}`,
    trustLevel: 'internal',
    fetchedAt: new Date().toISOString(),
  };
}
