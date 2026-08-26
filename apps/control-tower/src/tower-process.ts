import type http from 'node:http';
import { assertBindSafety, resolveBindHost } from '../../../packages/shared/src/index.js';
import {
  createAuthorityRuntime,
  type AuthorityRuntimePort,
} from './authority-runtime.js';

type TowerProcessServerOptions = {
  readonly authorityRuntime: AuthorityRuntimePort;
  readonly seedOnStart: boolean;
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
  const server = options.createServer({
    authorityRuntime,
    seedOnStart: environment.SANGFOR_TOWER_SEED_PLAYBOOKS !== '0',
  });
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
