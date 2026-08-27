import { loadEnvFile } from '../../../packages/sangfor-collector/src/load-env.js';
import { resolveRepoData } from '../../../packages/shared/src/index.js';
import { startStdioServer } from './stdio-server.js';

export { configureJmBrowserRuntime } from './browser-runtime-composition.js';
export { getPrompt, listPrompts, referencedToolNames } from './mcp-prompts.js';
export { listResources, readResource } from './mcp-resources.js';
export { handle } from './mcp-runtime.js';
export { runSafetySelftest } from './safety-selftest.js';
export { getToolHandler, listTools, listToolsForProfile } from './tool-registry.js';
export { activeToolProfile } from './tool-profile.js';

if (process.env.MCP_NO_SERVE !== '1' && process.env.VITEST === undefined) {
  loadEnvFile('.env', resolveRepoData('.'));
  startStdioServer();
}
