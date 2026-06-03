import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KnowledgeChunk, normalizeProduct, nowId } from '@sangfor/shared';

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

export interface WikiAdapter {
  readPage(path: string): Promise<string>;
  writePage(path: string, content: string, message: string): Promise<{ ok: boolean; path: string; message: string }>;
}

export class ObsidianVaultAdapter implements WikiAdapter {
  constructor(private readonly vaultPath: string) {}

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
    mkdirSync(dirname(pagePath), { recursive: true });
    writeFileSync(pagePath, content);
    return { ok: true, path: pagePath, message };
  }
}

export class GitHubWikiGitAdapter implements WikiAdapter {
  constructor(private readonly options: { repoUrl: string; localPath: string; branch?: string }) {}

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
    this.ensureRepo();
    const pagePath = this.resolvePage(path);
    mkdirSync(dirname(pagePath), { recursive: true });
    writeFileSync(pagePath, content);
    execFileSync('git', ['-C', this.options.localPath, 'add', pagePath], { stdio: 'ignore' });
    execFileSync('git', ['-C', this.options.localPath, 'commit', '-m', message], { stdio: 'ignore' });
    execFileSync('git', ['-C', this.options.localPath, 'push'], { stdio: 'ignore' });
    return { ok: true, path: pagePath, message };
  }
}

const proposals = new Map<string, WikiUpdateProposal>();

export function searchWiki(input: { product?: string; version?: string; query?: string; limit?: number }): KnowledgeChunk[] {
  const product = normalizeProduct(input.product);
  const query = (input.query ?? '').toLowerCase();
  return WIKI_CHUNKS
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

export function proposeWikiUpdate(input: { lessonTitle: string; lessonBody: string; targetPage?: string; adapter?: WikiUpdateProposal['adapter'] }): WikiUpdateProposal {
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
  proposals.set(id, proposal);
  return proposal;
}

export function approveWikiUpdate(proposalId: string, decision: 'approved' | 'rejected', reviewer = 'manual-reviewer'): WikiUpdateProposal {
  const proposal = proposals.get(proposalId);
  if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
  proposal.status = decision;
  proposal.reviewer = reviewer;
  return proposal;
}

export async function applyWikiUpdateWithAdapter(proposalId: string, adapter: WikiAdapter): Promise<WikiUpdateProposal & { writeResult: unknown }> {
  const proposal = proposals.get(proposalId);
  if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
  if (proposal.status !== 'approved') throw new Error('Wiki update is blocked until approval is granted.');
  const current = await adapter.readPage(proposal.targetPage);
  proposal.beforeText = current || '<new page>';
  const separator = current.trim() ? '\n\n' : '';
  const next = `${current}${separator}${proposal.afterText}`;
  const writeResult = await adapter.writePage(proposal.targetPage, next, `docs: ${proposal.title}`);
  proposal.status = 'applied';
  return { ...proposal, writeResult };
}

export function applyWikiUpdate(proposalId: string): WikiUpdateProposal {
  const proposal = proposals.get(proposalId);
  if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
  if (proposal.status !== 'approved') throw new Error('Wiki update is blocked until approval is granted.');
  proposal.status = 'applied';
  return proposal;
}

export async function applyObsidianWikiUpdate(input: { proposalId: string; vaultPath: string }): Promise<WikiUpdateProposal & { writeResult: unknown }> {
  return applyWikiUpdateWithAdapter(input.proposalId, new ObsidianVaultAdapter(input.vaultPath));
}

export async function applyGitHubWikiUpdate(input: { proposalId: string; repoUrl: string; localPath?: string }): Promise<WikiUpdateProposal & { writeResult: unknown }> {
  const localPath = input.localPath ?? 'data/wiki/github-wiki';
  return applyWikiUpdateWithAdapter(input.proposalId, new GitHubWikiGitAdapter({ repoUrl: input.repoUrl, localPath }));
}
