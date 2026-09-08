import { execFileSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nowId, expectedLocalWriteScope, requireLocalWriteAuthority, appendJsonl, type LocalWriteAuthority } from '@sangfor/shared';
import { cardsFile, getProposal, proposalsFile, wikiRoot } from './wiki-store.js';
import type { KnowledgeCard, WikiAdapter, WikiUpdateProposal } from './wiki-types.js';
import { LegacyWikiWriteApiError, type AuthorizedGitHubApplyInput, type AuthorizedObsidianApplyInput,
  type GitHubApplyInput, type KnowledgeCardInput, type ObsidianApplyInput, type WikiApprovalOptions, type WikiProposalInput } from './wiki-write-compat.js';

export type { KnowledgeCard, KnowledgeCardCitation, KnowledgeCardType, WikiAdapter, WikiUpdateProposal } from './wiki-types.js';
export { listSeedWiki } from './wiki-seed.js';
export { searchWiki } from './wiki-search.js';
export { listKnowledgeCards } from './wiki-store.js';

export class ObsidianVaultAdapter implements WikiAdapter {
  private readonly authority?: LocalWriteAuthority;
  constructor(private readonly vaultPath: string, authority?: LocalWriteAuthority) {
    this.authority = authority === undefined ? undefined : requireLocalWriteAuthority(authority, expectedLocalWriteScope(
      authority, authority.projectId, 'wiki_proposals', this.vaultPath,
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
    if (!this.authority) throw new LegacyWikiWriteApiError('ObsidianVaultAdapter.writePage', 'new ObsidianVaultAdapter(vaultPath, authority)');
    return this.authority.fence.write(this.authority, { operation: 'wiki.obsidian-write', targetPaths: [pagePath] }, () => {
      mkdirSync(dirname(pagePath), { recursive: true });
      writeFileSync(pagePath, content);
      return { ok: true, path: pagePath, message };
    });
  }
}

export class GitHubWikiGitAdapter implements WikiAdapter {
  private readonly authority?: LocalWriteAuthority;
  constructor(private readonly options: { readonly repoUrl: string; readonly localPath: string; readonly branch?: string }, authority?: LocalWriteAuthority) {
    this.authority = authority === undefined ? undefined : requireLocalWriteAuthority(authority, expectedLocalWriteScope(
      authority, authority.projectId, 'wiki_proposals', this.options.localPath,
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
    if (!this.authority) throw new LegacyWikiWriteApiError('GitHubWikiGitAdapter.readPage', 'new GitHubWikiGitAdapter(options, authority)');
    await this.authority.fence.write(this.authority, { operation: 'wiki.github-sync', targetPaths: [this.options.localPath] }, () => this.ensureRepo());
    const pagePath = this.resolvePage(path);
    return existsSync(pagePath) ? readFileSync(pagePath, 'utf8') : '';
  }

  async writePage(path: string, content: string, message: string): Promise<{ ok: boolean; path: string; message: string }> {
    const pagePath = this.resolvePage(path);
    if (!this.authority) throw new LegacyWikiWriteApiError('GitHubWikiGitAdapter.writePage', 'new GitHubWikiGitAdapter(options, authority)');
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

export function upsertKnowledgeCard(input: KnowledgeCardInput): KnowledgeCard;
export function upsertKnowledgeCard(input: KnowledgeCardInput, injectedAuthority: LocalWriteAuthority): Promise<KnowledgeCard>;
export function upsertKnowledgeCard(
  input: KnowledgeCardInput,
  injectedAuthority?: LocalWriteAuthority,
): KnowledgeCard | Promise<KnowledgeCard> {
  if (!injectedAuthority) throw new LegacyWikiWriteApiError('upsertKnowledgeCard', 'upsertKnowledgeCardWithAuthority');
  const card: KnowledgeCard = {
    ...input,
    id: input.id ?? nowId('knowledge_card'),
    updatedAt: new Date().toISOString()
  };
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority.projectId, 'wiki_proposals', wikiRoot(),
  ));
  return authority.fence.write(authority, { operation: 'wiki.upsert-card', targetPaths: [cardsFile()] }, () => {
    if (input.citations.length === 0) throw new Error('KnowledgeCard requires at least one source citation.');
    saveCard(card);
    return card;
  });
}

export const upsertKnowledgeCardWithAuthority = (input: KnowledgeCardInput, authority: LocalWriteAuthority): Promise<KnowledgeCard> =>
  upsertKnowledgeCard(input, authority);

export function proposeWikiUpdate(input: WikiProposalInput): WikiUpdateProposal;
export function proposeWikiUpdate(input: WikiProposalInput, injectedAuthority: LocalWriteAuthority): Promise<WikiUpdateProposal>;
export function proposeWikiUpdate(
  input: WikiProposalInput,
  injectedAuthority?: LocalWriteAuthority,
): WikiUpdateProposal | Promise<WikiUpdateProposal> {
  if (!injectedAuthority) throw new LegacyWikiWriteApiError('proposeWikiUpdate', 'proposeWikiUpdateWithAuthority');
  const proposal: WikiUpdateProposal = {
    id: nowId('wiki_proposal'),
    targetPage: input.targetPage ?? 'Sangfor/Lessons/Pending.md',
    title: input.lessonTitle,
    beforeText: '<current page content not loaded in proposal stage>',
    afterText: `## ${input.lessonTitle}\n\n${input.lessonBody}\n`,
    status: 'pending',
    adapter: input.adapter ?? 'memory'
  };
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority.projectId, 'wiki_proposals', wikiRoot(),
  ));
  return authority.fence.write(authority, { operation: 'wiki.propose', targetPaths: [proposalsFile()] }, () => {
    saveProposal(proposal);
    return proposal;
  });
}

export const proposeWikiUpdateWithAuthority = (input: WikiProposalInput, authority: LocalWriteAuthority): Promise<WikiUpdateProposal> =>
  proposeWikiUpdate(input, authority);

function wikiApprovalMac(secret: string, proposalId: string): Buffer {
  return createHmac('sha256', secret).update(proposalId).digest();
}

export function mintWikiApproval(proposalId: string): string {
  const secret = process.env.SANGFOR_WIKI_APPROVAL_SECRET;
  if (!secret) throw new Error('Wiki approval blocked: SANGFOR_WIKI_APPROVAL_SECRET is not configured (fail-closed).');
  return wikiApprovalMac(secret, proposalId).toString('hex');
}

export function approveWikiUpdate(
  proposalId: string,
  decision: 'approved' | 'rejected',
  opts?: WikiApprovalOptions,
): WikiUpdateProposal;
export function approveWikiUpdate(
  proposalId: string,
  decision: 'approved' | 'rejected',
  opts: WikiApprovalOptions,
  injectedAuthority: LocalWriteAuthority,
): Promise<WikiUpdateProposal>;
export function approveWikiUpdate(
  proposalId: string,
  decision: 'approved' | 'rejected',
  opts: WikiApprovalOptions = {},
  injectedAuthority?: LocalWriteAuthority,
): WikiUpdateProposal | Promise<WikiUpdateProposal> {
  if (!injectedAuthority) throw new LegacyWikiWriteApiError('approveWikiUpdate', 'approveWikiUpdateWithAuthority');
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority.projectId, 'wiki_proposals', wikiRoot(),
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

export const approveWikiUpdateWithAuthority = (
  proposalId: string, decision: 'approved' | 'rejected', opts: WikiApprovalOptions, authority: LocalWriteAuthority,
): Promise<WikiUpdateProposal> => approveWikiUpdate(proposalId, decision, opts, authority);

export async function applyWikiUpdateWithAdapter(
  proposalId: string,
  adapter: WikiAdapter,
  injectedAuthority?: LocalWriteAuthority,
): Promise<WikiUpdateProposal & { writeResult: unknown }> {
  if (!injectedAuthority) throw new LegacyWikiWriteApiError('applyWikiUpdateWithAdapter', 'applyWikiUpdateWithAdapterAndAuthority');
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority.projectId, 'wiki_proposals', wikiRoot(),
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

export const applyWikiUpdateWithAdapterAndAuthority = (
  proposalId: string, adapter: WikiAdapter, authority: LocalWriteAuthority,
): Promise<WikiUpdateProposal & { writeResult: unknown }> => applyWikiUpdateWithAdapter(proposalId, adapter, authority);

export function applyWikiUpdate(proposalId: string): WikiUpdateProposal;
export function applyWikiUpdate(proposalId: string, injectedAuthority: LocalWriteAuthority): Promise<WikiUpdateProposal>;
export function applyWikiUpdate(
  proposalId: string,
  injectedAuthority?: LocalWriteAuthority,
): WikiUpdateProposal | Promise<WikiUpdateProposal> {
  if (!injectedAuthority) throw new LegacyWikiWriteApiError('applyWikiUpdate', 'applyWikiUpdateWithAuthority');
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority.projectId, 'wiki_proposals', wikiRoot(),
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

export const applyWikiUpdateWithAuthority = (proposalId: string, authority: LocalWriteAuthority): Promise<WikiUpdateProposal> =>
  applyWikiUpdate(proposalId, authority);

export async function applyObsidianWikiUpdate(
  input: ObsidianApplyInput | AuthorizedObsidianApplyInput,
): Promise<WikiUpdateProposal & { writeResult: unknown }> {
  if (!('proposalAuthority' in input) || !('adapterAuthority' in input)) {
    throw new LegacyWikiWriteApiError('applyObsidianWikiUpdate', 'applyObsidianWikiUpdateWithAuthority');
  }
  return applyWikiUpdateWithAdapter(
    input.proposalId, new ObsidianVaultAdapter(input.vaultPath, input.adapterAuthority), input.proposalAuthority,
  );
}

export const applyObsidianWikiUpdateWithAuthority = (
  input: AuthorizedObsidianApplyInput,
): Promise<WikiUpdateProposal & { writeResult: unknown }> => applyObsidianWikiUpdate(input);

export async function applyGitHubWikiUpdate(
  input: GitHubApplyInput | AuthorizedGitHubApplyInput,
): Promise<WikiUpdateProposal & { writeResult: unknown }> {
  if (!('proposalAuthority' in input) || !('adapterAuthority' in input)) {
    throw new LegacyWikiWriteApiError('applyGitHubWikiUpdate', 'applyGitHubWikiUpdateWithAuthority');
  }
  const localPath = input.localPath ?? 'data/wiki/github-wiki';
  return applyWikiUpdateWithAdapter(
    input.proposalId, new GitHubWikiGitAdapter({ repoUrl: input.repoUrl, localPath }, input.adapterAuthority), input.proposalAuthority,
  );
}

export const applyGitHubWikiUpdateWithAuthority = (
  input: AuthorizedGitHubApplyInput,
): Promise<WikiUpdateProposal & { writeResult: unknown }> => applyGitHubWikiUpdate(input);
