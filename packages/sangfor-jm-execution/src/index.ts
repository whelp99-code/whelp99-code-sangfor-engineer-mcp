export { createLocalJmExecutionPort } from './local-port.js';
export { createPlaywrightJmBrowserDriver } from './playwright-driver.js';
export { createJmObserverTransport } from './observer-transport.js';
export {
  clickUniqueTextTarget,
  selectUniqueTarget,
  typeUniqueInputTarget,
} from './semantic-targets.js';
export type {
  JmBrowserDriver,
  JmArtifactMaterializer,
  LocalJmExecutionOptions,
  LocalJmMode,
  LocalJmSession,
} from './types.js';
export type { PlaywrightJmBrowserDriverOptions } from './playwright-driver.js';
