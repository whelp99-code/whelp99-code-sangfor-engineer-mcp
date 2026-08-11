import type {
  BrowserExecutionRequest,
  BrowserExecutionResult,
} from '../../sangfor-browser-contracts/src/index.js';

export type LocalJmMode =
  | 'mock'
  | 'lab'
  | 'poc'
  | 'customer_readonly'
  | 'customer_write'
  | 'production';

export interface LocalJmSession {
  sessionId: string;
  origin: string;
  targetUrl?: string;
  mode: LocalJmMode;
  profileRef?: string;
  authRef?: string;
  cdpPort?: number;
  chromiumPath?: string;
  headless?: boolean;
  credentials?: { username: string; password: string };
}

export interface JmBrowserDriver {
  execute(
    session: LocalJmSession,
    request: BrowserExecutionRequest,
  ): Promise<BrowserExecutionResult>;
  closeSession(session: LocalJmSession): Promise<void>;
}

export interface JmArtifactMaterializer {
  materializeArtifact(artifactRef: string, destinationPath: string): Promise<void>;
}

export interface JmBrowserRuntimeLifecycle {
  closeAll(): Promise<void>;
}

export interface LocalJmExecutionOptions {
  resolveSession(sessionId: string): LocalJmSession | undefined;
  driver: JmBrowserDriver;
}
