import { execFileSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nowId, expectedLocalWriteScope, requireLocalWriteAuthority, appendJsonl, type LocalWriteAuthority } from '@sangfor/shared';
import { cardsFile, getProposal, proposalsFile, wikiRoot } from './wiki-store.js';
import type { KnowledgeCard, WikiAdapter, WikiUpdateProposal } from './wiki-types.js';

export type {
  KnowledgeCard, KnowledgeCardCitation, KnowledgeCardType, WikiAdapter, WikiUpdateProposal,
} from './wiki-types.js';
export { listSeedWiki } from './wiki-seed.js';
export { searchWiki } from './wiki-search.js';
export { listKnowledgeCards } from './wiki-store.js';

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

const saveProposal = (proposal: WikiUpdateProposal) => appendJsonl(proposalsFile(), proposal);
const saveCard = (card: KnowledgeCard) => appendJsonl(cardsFile(), card);

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
