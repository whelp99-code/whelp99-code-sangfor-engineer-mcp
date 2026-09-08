import { join } from 'node:path';
import { resolveEngagementScopedData, resolveProductionLocalWriteAuthority, resolveRepoData } from '../../../packages/shared/src/index.js';

export const mcpLocalAuthority = (aggregate: string, sourceRoot: string) => resolveProductionLocalWriteAuthority({
  tenantId: process.env.SANGFOR_TENANT_ID ?? 'local-primary',
  projectId: process.env.SANGFOR_ENGAGEMENT_ID ?? 'local-primary',
  actorId: 'mcp-server', aggregate, sourceRoot,
});
export const auditRoot = () => join(resolveEngagementScopedData('data/evidence'), 'change-runs');
export const wikiRoot = () => resolveRepoData('data/wiki', 'SANGFOR_WIKI_ROOT');
export const evalRoot = () => resolveRepoData('data/evals', 'SANGFOR_EVALS_ROOT');
