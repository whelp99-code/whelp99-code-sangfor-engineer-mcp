import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  restoreSiteLearningCheckpoint,
  runTwoSiteLearning,
  type SiteLearningCheckpoint,
  type SiteLearningReport,
} from '../packages/sangfor-collector/src/site-learning-crawler.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

const stats = {
  discovered: 1,
  fetched: 1,
  accepted: 1,
  rejected: {},
  duplicates: 0,
  errors: 0,
} as const;

const checkpoint: SiteLearningCheckpoint = {
  version: 1,
  completed: true,
  documents: [],
  contentHashes: [],
  support: stats,
  community: stats,
  limitState: {
    supportLimitReached: false,
    communityForumLimitApplied: false,
    communityPageLimitApplied: false,
    communityThreadLimitApplied: false,
  },
};

const report: SiteLearningReport = {
  startedAt: '2026-08-31T00:00:00.000Z',
  completedAt: '2026-08-31T00:01:00.000Z',
  sourceRoots: ['https://support.sangfor.com/', 'https://community.sangfor.com/'],
  support: stats,
  community: stats,
  documents: 0,
  frontierExhausted: true,
  truncatedByLimit: [],
};

describe('site learning valid and invalid runtime driver', () => {
  it('Given a valid completed checkpoint, When the public runner resumes, Then no browser or network is required', async () => {
    // Given
    const root = temporaryRoot('collector-valid-driver-');
    const checkpointPath = join(root, 'checkpoint.json');
    const reportPath = join(root, 'report.json');
    const rawDir = join(root, 'raw');
    writeFileSync(checkpointPath, JSON.stringify(checkpoint));
    writeFileSync(reportPath, JSON.stringify(report));

    // When
    const result = await runTwoSiteLearning({
      checkpointPath,
      reportPath,
      rawDir,
      browserExecutablePath: '/invalid/browser-must-not-launch',
    });

    // Then
    expect(result).toEqual({ report, documents: [], files: [] });
  });

  it('Given invalid checkpoint input, When the public boundary rejects, Then it leaves no residue', () => {
    // Given
    const root = temporaryRoot('collector-invalid-driver-');
    const inputDir = join(root, 'input');
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, 'checkpoint.json'), '{"version":2}');
    const before = readdirSync(root, { recursive: true }).sort();

    // When
    const action = () => restoreSiteLearningCheckpoint('{"version":2}');

    // Then
    expect(action).toThrow('INVALID_TWO_SITE_CHECKPOINT');
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
  });
});
