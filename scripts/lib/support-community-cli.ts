export const SUPPORT_COMMUNITY_HELP = `Usage: pnpm run learn:sites:full

Crawls the registered Sangfor Support and Community learning sites, writes raw
documents, updates the collected-source manifest, ingests documents into the RAG
index, and rebuilds the lesson-extraction fine-tune dataset.

Important environment controls:
  SANGFOR_TWO_SITE_FRESH=1                  remove the previous checkpoint first
  SANGFOR_SUPPORT_MAX_VERSIONS=<n>          cap Support product versions
  SANGFOR_SUPPORT_MAX_DOCUMENTS=<n>         cap Support documents
  SANGFOR_COMMUNITY_MAX_FORUMS=<n>          cap Community forums
  SANGFOR_COMMUNITY_MAX_PAGES_PER_FORUM=<n> cap Community forum pages
  SANGFOR_COMMUNITY_MAX_THREADS=<n>         cap Community threads
  SANGFOR_SITE_CRAWL_DELAY_MS=<n>           polite delay between page actions
`;

export function supportCommunityCliHelp(arguments_: readonly string[]): string | undefined {
  return arguments_.some((argument) => argument === '--help' || argument === '-h')
    ? SUPPORT_COMMUNITY_HELP
    : undefined;
}
