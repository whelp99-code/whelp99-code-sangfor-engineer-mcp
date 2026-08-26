import type http from 'node:http';
import { assertBindSafety, resolveBindHost, resolveEngagementScopedData, resolveRepoData, type LocalWriteAuthority } from '../../../packages/shared/src/index.js';
import {
  createAuthorityRuntime,
  type AuthorityRuntimePort,
} from './authority-runtime.js';

type TowerProcessServerOptions = {
  readonly authorityRuntime: AuthorityRuntimePort;
  readonly seedOnStart: boolean;
  readonly authorityMode: 'postgres';
  readonly localAuthorities: Record<'registry_services' | 'runs_steps' | 'pm_tasks', LocalWriteAuthority>;
};

type TowerProcessOptions = {
  readonly createServer: (options: TowerProcessServerOptions) => http.Server;
  readonly environment?: NodeJS.ProcessEnv;
};

export async function startTowerProcess(options: TowerProcessOptions): Promise<void> {
  const environment = options.environment ?? process.env;
  const port = Number(environment.PORT ?? environment.CONTROL_TOWER_PORT ?? 3700);
  const bindHost = resolveBindHost();
  const apiToken = environment.SANGFOR_API_TOKEN;
  assertBindSafety(bindHost, apiToken);
  const authorityRuntime = createAuthorityRuntime({ environment });
  await authorityRuntime.start();
  await authorityRuntime.assertReady();
  const actorId = environment.SANGFOR_ACTOR_ID?.trim();
  if (!actorId) { await authorityRuntime.close(); throw new Error('SANGFOR_ACTOR_ID is required'); }
  const runsRoot = resolveEngagementScopedData('data/runs', 'SANGFOR_RUNS_ROOT');
  const registryRoot = resolveRepoData('data/registry', 'SANGFOR_REGISTRY_ROOT');
  const localAuthorities = {
    registry_services: await authorityRuntime.localWriteAuthority('registry_services', registryRoot, actorId),
    runs_steps: await authorityRuntime.localWriteAuthority('runs_steps', runsRoot, actorId),
    pm_tasks: await authorityRuntime.localWriteAuthority('pm_tasks', registryRoot, actorId),
  };
  const server = options.createServer({
    authorityRuntime, authorityMode: 'postgres', localAuthorities,
    seedOnStart: environment.SANGFOR_TOWER_SEED_PLAYBOOKS !== '0',
  });
  const startup = (server as http.Server & { startup?: () => Promise<void> }).startup;
  if (startup) await startup();
  server.listen(port, bindHost, () => {
    const address = server.address();
    const listeningPort = address && typeof address !== 'string' ? address.port : port;
    console.log(`Sangfor Control Tower listening on http://${bindHost}:${listeningPort}${apiToken ? ' (token-gated)' : ''}`);
  });
  const drain = (): void => {
    authorityRuntime.beginDrain();
    server.close(() => { void authorityRuntime.close(); });
  };
  process.once('SIGTERM', drain);
  process.once('SIGINT', drain);
}
