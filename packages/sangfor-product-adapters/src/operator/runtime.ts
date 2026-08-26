import type { IagExecutor } from '../apply/iag-executor.js';
import type { FileIagOrchestratorStore } from './store.js';

export type IagOrchestratorRuntime = {
  readonly executor: IagExecutor;
  readonly store: FileIagOrchestratorStore;
  readonly now: () => Date;
};
