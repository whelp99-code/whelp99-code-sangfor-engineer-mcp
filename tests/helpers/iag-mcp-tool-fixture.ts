import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  configureIagOrchestratorToolService,
  IagOrchestratorToolService,
} from '../../apps/mcp-server/src/iag-orchestrator-tools.js';
import {
  IAG_ORCHESTRATOR_NOW,
  iagOrchestratorFixture,
} from './iag-orchestrator-fixture.js';

export async function configureIagMcpFixture(input: {
  readonly root: string;
  readonly dryRun: boolean;
  readonly authorityKind?: 'bootstrap_candidate' | 'ordinary_active';
}) {
  const fixture = await iagOrchestratorFixture(input);
  const actionPath = join(input.root, 'action.json');
  const configPath = join(input.root, 'config.json');
  const approvalEnvelopePath = join(input.root, 'approval.json');
  writeFileSync(actionPath, fixture.source);
  writeFileSync(approvalEnvelopePath, JSON.stringify(fixture.approval));
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 'iag-mcp-config.v1',
    authority: {
      references: fixture.authorityRequest.references,
      origin: fixture.authorityRequest.origin,
      allowedUrlDomains: fixture.authorityRequest.allowedUrlDomains,
      allowedApplicationIds: fixture.authorityRequest.allowedApplicationIds,
      firmwareFreshness: fixture.authorityRequest.firmwareFreshness,
    },
    orchestrator: { ledgerPath: fixture.ledgerPath },
  }));
  configureIagOrchestratorToolService(new IagOrchestratorToolService({
    executionPort: fixture.adapterFixture.executionPort,
    readBackPort: fixture.adapterFixture.readBackPort,
    now: () => IAG_ORCHESTRATOR_NOW,
  }));
  return { fixture, actionPath, configPath, approvalEnvelopePath };
}
