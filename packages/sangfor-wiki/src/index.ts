import { execFileSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KnowledgeChunk, ProductCode, normalizeProduct, nowId, expectedLocalWriteScope, requireLocalWriteAuthority, resolveRepoData, appendJsonl, foldJsonlById, type LocalWriteAuthority } from '@sangfor/shared';

const WIKI_CHUNKS: KnowledgeChunk[] = [
  {
    id: 'wiki_hci_mtu_lesson_001',
    sourceType: 'wiki',
    product: 'HCI',
    title: 'HCI 3-Node Deployment Lessons',
    section: 'Storage Network MTU',
    text: 'Internal lesson: HCI 3-node deployment should include MTU consistency check on storage network before cluster initialization. Missing this precheck caused unstable storage heartbeat in previous PoC.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_iag_policy_order_001',
    sourceType: 'wiki',
    product: 'IAG',
    title: 'IAG Policy Ordering Notes',
    section: 'Policy Priority',
    text: 'Internal lesson: define emergency bypass and admin exception policy before applying restrictive internet access policies. Always capture current policy export before applying changes.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_es_staged_rollout_001',
    sourceType: 'wiki',
    product: 'ENDPOINT_SECURE',
    title: 'Endpoint Secure Staged Rollout',
    section: 'Pilot Group',
    text: 'Internal lesson: deploy Endpoint Secure agents to a pilot group first, validate performance impact, then expand by department. Keep rollback uninstall package ready.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_cc_time_sync_001',
    sourceType: 'wiki',
    product: 'CYBER_COMMAND',
    title: 'Cyber Command Event Correlation',
    section: 'NTP and Timezone',
    text: 'Internal lesson: event correlation quality depends on NTP and timezone consistency across all sources. Add NTP validation to Cyber Command onboarding precheck.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_hci_license_001',
    sourceType: 'wiki',
    product: 'HCI',
    title: 'HCI License Activation Pitfall',
    section: 'Cluster UUID',
    text: 'Internal lesson: activate licenses only after all nodes join cluster; re-activation may be required if a node is replaced with different hardware UUID.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_hci_vmware_001',
    sourceType: 'wiki',
    product: 'HCI',
    title: 'VMware to HCI Migration',
    section: 'Cutover Window',
    text: 'Internal lesson: keep source VMware powered off validation step in runbook; document LUN mapping and boot order before cutover weekend.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_iag_ssl_001',
    sourceType: 'wiki',
    product: 'IAG',
    title: 'IAG SSL Inspection Exceptions',
    section: 'Certificate Pinning Apps',
    text: 'Internal lesson: maintain exception list for banking and health apps that break on SSL inspection; review quarterly.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_es_perf_001',
    sourceType: 'wiki',
    product: 'ENDPOINT_SECURE',
    title: 'Endpoint Secure Performance',
    section: 'Full Scan Schedule',
    text: 'Internal lesson: schedule full scans outside business hours; disable concurrent full scan on VDI gold images.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_cc_playbook_001',
    sourceType: 'wiki',
    product: 'CYBER_COMMAND',
    title: 'SOC Playbook Links',
    section: 'Runbook Integration',
    text: 'Internal lesson: link each high-severity alert rule to Confluence/Jira runbook URL in rule description for faster L1 response.',
    trustLevel: 'internal'
  }
];

export interface WikiUpdateProposal {
  id: string;
  targetPage: string;
  title: string;
  beforeText: string;
  afterText: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied';
  adapter?: 'memory' | 'obsidian' | 'github_wiki';
  reviewer?: string;
}

export type KnowledgeCardType = 'procedure' | 'troubleshooting' | 'known_issue' | 'config_recipe' | 'compatibility_note';

export interface KnowledgeCardCitation {
  sourceId: string;
  sourceRevision?: string;
  headingPath?: string[];
  spanText: string;
  quoteHash: string;
}

export interface KnowledgeCard {
  id: string;
  type: KnowledgeCardType;
  product: ProductCode;
  version?: string;
  title: string;
  symptom?: string;
  cause?: string;
  prerequisites: string[];
  steps: string[];
  warnings: string[];
  verification: string[];
  rollback: string[];
  citations: KnowledgeCardCitation[];
  trustLevel: KnowledgeChunk['trustLevel'];
  updatedAt: string;
}

export interface WikiAdapter {
  readPage(path: string): Promise<string>;
  writePage(path: string, content: string, message: string): Promise<{ ok: boolean; path: string; message: string }>;
}

export class ObsidianVaultAdapter implements WikiAdapter {
  private readonly authority: LocalWriteAuthority;
  constructor(private readonly vaultPath: string, authority: LocalWriteAuthority) {
    this.authority = requireLocalWriteAuthority(authority, expectedLocalWriteScope(
      authority, authority?.projectId ?? '', 'wiki_proposals', this.vaultPath,
    ));
  }

  private resolvePage(path: string): string {
    const safePath = path.replace(/^\/+/, '').replace(/\.\./g, '');
    return join(this.vaultPath, safePath.endsWith('.md') ? safePath : `${safePath}.md`);
  }

  async readPage(path: string): Promise<string> {
    const pagePath = this.resolvePage(path);
    return existsSync(pagePath) ? readFileSync(pagePath, 'utf8') : '';
  }

  async writePage(path: string, content: string, message: string): Promise<{ ok: boolean; path: string; message: string }> {
    const pagePath = this.resolvePage(path);
    return this.authority.fence.write(this.authority, { operation: 'wiki.obsidian-write', targetPaths: [pagePath] }, () => {
      mkdirSync(dirname(pagePath), { recursive: true });
      writeFileSync(pagePath, content);
      return { ok: true, path: pagePath, message };
    });
  }
}

export class GitHubWikiGitAdapter implements WikiAdapter {
  private readonly authority: LocalWriteAuthority;
  constructor(private readonly options: { repoUrl: string; localPath: string; branch?: string }, authority: LocalWriteAuthority) {
    this.authority = requireLocalWriteAuthority(authority, expectedLocalWriteScope(
      authority, authority?.projectId ?? '', 'wiki_proposals', this.options.localPath,
    ));
  }

  private ensureRepo(): void {
    if (!existsSync(this.options.localPath)) {
      execFileSync('git', ['clone', this.options.repoUrl, this.options.localPath], { stdio: 'ignore' });
    } else {
      execFileSync('git', ['-C', this.options.localPath, 'pull', '--ff-only'], { stdio: 'ignore' });
    }
  }

  private resolvePage(path: string): string {
    const safePath = path.replace(/^\/+/, '').replace(/\.\./g, '');
    return join(this.options.localPath, safePath.endsWith('.md') ? safePath : `${safePath}.md`);
  }

  async readPage(path: string): Promise<string> {
    this.ensureRepo();
    const pagePath = this.resolvePage(path);
    return existsSync(pagePath) ? readFileSync(pagePath, 'utf8') : '';
  }

  async writePage(path: string, content: string, message: string): Promise<{ ok: boolean; path: string; message: string }> {
    const pagePath = this.resolvePage(path);
    return this.authority.fence.write(this.authority, { operation: 'wiki.github-write', targetPaths: [pagePath] }, () => {
      this.ensureRepo();
      mkdirSync(dirname(pagePath), { recursive: true });
      writeFileSync(pagePath, content);
      execFileSync('git', ['-C', this.options.localPath, 'add', pagePath], { stdio: 'ignore' });
      execFileSync('git', ['-C', this.options.localPath, 'commit', '-m', message], { stdio: 'ignore' });
      execFileSync('git', ['-C', this.options.localPath, 'push'], { stdio: 'ignore' });
      return { ok: true, path: pagePath, message };
    });
  }
}

const wikiRoot = () => resolveRepoData('data/wiki', 'SANGFOR_WIKI_ROOT');
const proposalsFile = () => join(wikiRoot(), 'proposals.jsonl');
const cardsFile = () => join(wikiRoot(), 'knowledge-cards.jsonl');
const getProposal = (id: string) => foldJsonlById<WikiUpdateProposal>(proposalsFile()).get(id);
const saveProposal = (proposal: WikiUpdateProposal) => appendJsonl(proposalsFile(), proposal);
const saveCard = (card: KnowledgeCard) => appendJsonl(cardsFile(), card);

export function listSeedWiki(): KnowledgeChunk[] {
  return [...WIKI_CHUNKS];
}

export function listKnowledgeCards(): KnowledgeCard[] {
  return [...foldJsonlById<KnowledgeCard>(cardsFile()).values()];
}

export async function upsertKnowledgeCard(input: Omit<KnowledgeCard, 'id' | 'updatedAt'> & { id?: string }, injectedAuthority: LocalWriteAuthority): Promise<KnowledgeCard> {
  if (input.citations.length === 0) {
    throw new Error('KnowledgeCard requires at least one source citation.');
  }
  const card: KnowledgeCard = {
    ...input,
    id: input.id ?? nowId('knowledge_card'),
    updatedAt: new Date().toISOString()
  };
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority?.projectId ?? '', 'wiki_proposals', wikiRoot(),
  ));
  await authority.fence.write(authority, { operation: 'wiki.upsert-card', targetPaths: [cardsFile()] }, () => saveCard(card));
  return card;
}

export function searchWiki(input: { product?: string; version?: string; query?: string; limit?: number }): KnowledgeChunk[] {
  const product = normalizeProduct(input.product);
  const query = (input.query ?? '').toLowerCase();
  const cardChunks: KnowledgeChunk[] = listKnowledgeCards().map((card) => ({
    id: card.id,
    sourceType: 'wiki',
    product: card.product,
    version: card.version,
    title: card.title,
    section: card.type,
    text: [
      card.symptom,
      card.cause,
      ...card.prerequisites,
      ...card.steps,
      ...card.warnings,
      ...card.verification,
      ...card.rollback
    ].filter(Boolean).join('\n'),
    trustLevel: card.trustLevel
  }));
  return [...WIKI_CHUNKS, ...cardChunks]
    .filter(chunk => chunk.product === product)
    .map(chunk => {
      const text = `${chunk.title} ${chunk.section ?? ''} ${chunk.text}`.toLowerCase();
      const score = query.split(/\s+/).filter(Boolean).reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
      return { chunk, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 5)
    .map(item => item.chunk);
}

export async function proposeWikiUpdate(input: { lessonTitle: string; lessonBody: string; targetPage?: string; adapter?: WikiUpdateProposal['adapter'] }, injectedAuthority: LocalWriteAuthority): Promise<WikiUpdateProposal> {
  const id = nowId('wiki_proposal');
  const targetPage = input.targetPage ?? 'Sangfor/Lessons/Pending.md';
  const proposal: WikiUpdateProposal = {
    id,
    targetPage,
    title: input.lessonTitle,
    beforeText: '<current page content not loaded in proposal stage>',
    afterText: `## ${input.lessonTitle}\n\n${input.lessonBody}\n`,
    status: 'pending',
    adapter: input.adapter ?? 'memory'
  };
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority?.projectId ?? '', 'wiki_proposals', wikiRoot(),
  ));
  await authority.fence.write(authority, { operation: 'wiki.propose', targetPaths: [proposalsFile()] }, () => saveProposal(proposal));
  return proposal;
}

function wikiApprovalMac(secret: string, proposalId: string): Buffer {
  return createHmac('sha256', secret).update(proposalId).digest();
}

export function mintWikiApproval(proposalId: string): string {
  const secret = process.env.SANGFOR_WIKI_APPROVAL_SECRET;
  if (!secret) throw new Error('Wiki approval blocked: SANGFOR_WIKI_APPROVAL_SECRET is not configured (fail-closed).');
  return wikiApprovalMac(secret, proposalId).toString('hex');
}

export async function approveWikiUpdate(
  proposalId: string,
  decision: 'approved' | 'rejected',
  opts: { reviewer?: string; token?: string } = {},
  injectedAuthority: LocalWriteAuthority,
): Promise<WikiUpdateProposal> {
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority?.projectId ?? '', 'wiki_proposals', wikiRoot(),
  ));
  return authority.fence.write(authority, { operation: 'wiki.approve', targetPaths: [proposalsFile()] }, () => {
    const proposal = getProposal(proposalId);
    if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
    if (decision === 'approved') {
      const secret = process.env.SANGFOR_WIKI_APPROVAL_SECRET;
      if (!secret) throw new Error('Wiki approval blocked: SANGFOR_WIKI_APPROVAL_SECRET is not configured (fail-closed).');
      const expected = wikiApprovalMac(secret, proposalId);
      const provided = Buffer.from(opts.token ?? '', 'hex');
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error('Wiki approval token is not a valid HMAC for this proposal.');
    }
    proposal.status = decision;
    proposal.reviewer = opts.reviewer ?? 'manual-reviewer';
    saveProposal(proposal);
    return proposal;
  });
}

export async function applyWikiUpdateWithAdapter(
  proposalId: string, adapter: WikiAdapter, injectedAuthority: LocalWriteAuthority,
): Promise<WikiUpdateProposal & { writeResult: unknown }> {
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority?.projectId ?? '', 'wiki_proposals', wikiRoot(),
  ));
  return authority.fence.write(authority, { operation: 'wiki.apply-adapter', targetPaths: [proposalsFile()] }, async () => {
    const proposal = getProposal(proposalId);
    if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
    if (proposal.status !== 'approved') throw new Error('Wiki update is blocked until approval is granted.');
    const current = await adapter.readPage(proposal.targetPage);
    proposal.beforeText = current || '<new page>';
    const next = `${current}${current.trim() ? '\n\n' : ''}${proposal.afterText}`;
    const writeResult = await adapter.writePage(proposal.targetPage, next, `docs: ${proposal.title}`);
    proposal.status = 'applied';
    saveProposal(proposal);
    return { ...proposal, writeResult };
  });
}

export async function applyWikiUpdate(proposalId: string, injectedAuthority: LocalWriteAuthority): Promise<WikiUpdateProposal> {
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority?.projectId ?? '', 'wiki_proposals', wikiRoot(),
  ));
  return authority.fence.write(authority, { operation: 'wiki.apply', targetPaths: [proposalsFile()] }, () => {
    const proposal = getProposal(proposalId);
    if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
    if (proposal.status !== 'approved') throw new Error('Wiki update is blocked until approval is granted.');
    proposal.status = 'applied';
    saveProposal(proposal);
    return proposal;
  });
}

export async function applyObsidianWikiUpdate(input: {
  proposalId: string; vaultPath: string; proposalAuthority: LocalWriteAuthority; adapterAuthority: LocalWriteAuthority;
}): Promise<WikiUpdateProposal & { writeResult: unknown }> {
  return applyWikiUpdateWithAdapter(
    input.proposalId, new ObsidianVaultAdapter(input.vaultPath, input.adapterAuthority), input.proposalAuthority,
  );
}

export async function applyGitHubWikiUpdate(input: {
  proposalId: string; repoUrl: string; localPath?: string;
  proposalAuthority: LocalWriteAuthority; adapterAuthority: LocalWriteAuthority;
}): Promise<WikiUpdateProposal & { writeResult: unknown }> {
  const localPath = input.localPath ?? 'data/wiki/github-wiki';
  return applyWikiUpdateWithAdapter(
    input.proposalId, new GitHubWikiGitAdapter({ repoUrl: input.repoUrl, localPath }, input.adapterAuthority), input.proposalAuthority,
  );
}
