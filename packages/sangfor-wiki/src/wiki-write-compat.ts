import type { LocalWriteAuthority } from '@sangfor/shared';
import type { KnowledgeCard, WikiUpdateProposal } from './wiki-types.js';

export type KnowledgeCardInput = Omit<KnowledgeCard, 'id' | 'updatedAt'> & { readonly id?: string };
export type WikiProposalInput = {
  readonly lessonTitle: string;
  readonly lessonBody: string;
  readonly targetPage?: string;
  readonly adapter?: WikiUpdateProposal['adapter'];
};
export type WikiApprovalOptions = { readonly reviewer?: string; readonly token?: string };
export type ObsidianApplyInput = { readonly proposalId: string; readonly vaultPath: string };
export type AuthorizedObsidianApplyInput = ObsidianApplyInput & {
  readonly proposalAuthority: LocalWriteAuthority;
  readonly adapterAuthority: LocalWriteAuthority;
};
export type GitHubApplyInput = { readonly proposalId: string; readonly repoUrl: string; readonly localPath?: string };
export type AuthorizedGitHubApplyInput = GitHubApplyInput & {
  readonly proposalAuthority: LocalWriteAuthority;
  readonly adapterAuthority: LocalWriteAuthority;
};

export class LegacyWikiWriteApiError extends Error {
  readonly name = 'LegacyWikiWriteApiError';

  constructor(readonly legacyApi: string, readonly replacementApi: string) {
    super(`${legacyApi} requires explicit local write authority; use ${replacementApi}.`);
  }
}
