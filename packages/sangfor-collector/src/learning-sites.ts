export type LearningSiteId = 'sangfor_support' | 'sangfor_community';

export interface LearningSite {
  id: LearningSiteId;
  rootUrl: string;
  host: string;
  source: 'support_site' | 'community_site';
  trustLevel: 'official' | 'internal';
  renderMode: 'browser';
}

export interface LearningUrlClassification {
  siteId?: LearningSiteId;
  allowed: boolean;
  reason?: string;
}

export const LEARNING_SITES: readonly LearningSite[] = [
  {
    id: 'sangfor_support',
    rootUrl: 'https://support.sangfor.com/',
    host: 'support.sangfor.com',
    source: 'support_site',
    trustLevel: 'official',
    renderMode: 'browser'
  },
  {
    id: 'sangfor_community',
    rootUrl: 'https://community.sangfor.com/plugin.php?id=info:index',
    host: 'community.sangfor.com',
    source: 'community_site',
    trustLevel: 'internal',
    renderMode: 'browser'
  }
] as const;

const TRACKING_PARAMS = new Set([
  'from',
  'fromuid',
  'goto',
  'handlekey',
  'mobile',
  'referer',
  'referrer',
  'utm_campaign',
  'utm_content',
  'utm_medium',
  'utm_source',
  'utm_term'
]);

const SUPPORT_DENIED_PATHS = [
  /^\/UserAccount(?:\/|$)/i,
  /^\/UserCollection(?:\/|$)/i,
  /^\/UserFollowProd(?:\/|$)/i,
  /^\/notice(?:\/|$)/i,
  /^\/user\/(?:login|logout|register)/i
];

const COMMUNITY_DENIED_PATHS = [
  /^\/(?:api|connect|cp|group|member|misc|search|sf|userapp)\.php$/i,
  /^\/(?:config|data|flexpaper|install|lib|mwebapp|public|sf|static|template|uc_client|uc_server|webapp)(?:\/|$)/i,
  /^\/_admin\.php$/i
];

function deniedCommunityQuery(url: URL): boolean {
  const mod = url.searchParams.get('mod')?.toLowerCase() ?? '';
  if (url.pathname === '/forum.php' && ['attachment', 'post', 'redirect'].includes(mod)) return true;
  if (url.pathname === '/home.php' && mod === 'spacecp') return true;
  return url.searchParams.get('inajax') === '1';
}

export function classifyLearningUrl(rawUrl: string): LearningUrlClassification {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { allowed: false, reason: 'unsupported_protocol' };
  }

  if (url.hostname === 'support.sangfor.com') {
    const denied = SUPPORT_DENIED_PATHS.some((pattern) => pattern.test(url.pathname));
    return denied
      ? { siteId: 'sangfor_support', allowed: false, reason: 'private_or_mutating_path' }
      : { siteId: 'sangfor_support', allowed: true };
  }

  if (url.hostname === 'community.sangfor.com') {
    const denied = COMMUNITY_DENIED_PATHS.some((pattern) => pattern.test(url.pathname))
      || deniedCommunityQuery(url);
    return denied
      ? { siteId: 'sangfor_community', allowed: false, reason: 'robots_excluded' }
      : { siteId: 'sangfor_community', allowed: true };
  }

  return { allowed: false, reason: 'outside_registered_hosts' };
}

export function canonicalizeLearningUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  url.protocol = 'https:';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  const ordered = [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = '';
  for (const [key, value] of ordered) url.searchParams.append(key, value);
  return url.toString();
}

export function isUsefulLearningText(text: string, title: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const normalizedTitle = title.replace(/\s+/g, ' ').trim();
  if (normalized.length < 180) return false;
  if (/^\s*(?:login|sign in)\s*$/i.test(normalized)) return false;
  if (/\b(?:login|sign in)\b/i.test(normalized) && normalized.length < 800) return false;
  if (/\b(?:system error|an error occurred|page not found|access denied)\b/i.test(normalizedTitle)) {
    return false;
  }
  const titleWords = new Set(normalizedTitle.toLowerCase().split(/\W+/).filter(Boolean));
  const contentWords = normalized.toLowerCase().split(/\W+/).filter(Boolean);
  const distinctContent = new Set(contentWords);
  return distinctContent.size >= Math.max(8, titleWords.size + 5);
}
