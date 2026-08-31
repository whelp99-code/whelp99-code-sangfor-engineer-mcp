import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractLesson,
  extractLessonWithAuthority,
  submitFeedback,
  submitFeedbackWithAuthority,
  type FeedbackEvent,
  type LessonLearned,
} from '../packages/sangfor-feedback/src/index.js';
import {
  GitHubWikiGitAdapter,
  ObsidianVaultAdapter,
  applyGitHubWikiUpdate,
  applyObsidianWikiUpdate,
  applyWikiUpdate,
  applyWikiUpdateWithAdapter,
  approveWikiUpdate,
  proposeWikiUpdate,
  proposeWikiUpdateWithAuthority,
  upsertKnowledgeCard,
  type KnowledgeCard,
  type WikiAdapter,
  type WikiUpdateProposal,
} from '../packages/sangfor-wiki/src/index.js';
import { testLocalWriteAuthority } from './helpers/local-write-authority.js';

const feedbackInput = {
  product: 'HCI',
  feedbackType: 'bug',
  severity: 'high',
  feedbackText: 'MTU mismatch',
  sourceRole: 'engineer',
} as const;

// This function is intentionally not invoked. Its body is compiled as an
// origin/main consumer contract, proving that the shipped one-argument API and
// synchronous return types remain source-compatible during the cutover.
function originMainConsumerCompiles(adapter: WikiAdapter, card: Omit<KnowledgeCard, 'id' | 'updatedAt'>): void {
  const feedback: FeedbackEvent = submitFeedback(feedbackInput);
  const lesson: LessonLearned = extractLesson(feedback.id);
  const proposal: WikiUpdateProposal = proposeWikiUpdate({ lessonTitle: lesson.lessonTitle, lessonBody: lesson.lessonBody });
  const approved: WikiUpdateProposal = approveWikiUpdate(proposal.id, 'rejected');
  const applied: WikiUpdateProposal = applyWikiUpdate(approved.id);
  const adapted: Promise<WikiUpdateProposal & { writeResult: unknown }> = applyWikiUpdateWithAdapter(applied.id, adapter);
  const obsidian: Promise<WikiUpdateProposal & { writeResult: unknown }> = applyObsidianWikiUpdate({ proposalId: applied.id, vaultPath: '/tmp/wiki' });
  const github: Promise<WikiUpdateProposal & { writeResult: unknown }> = applyGitHubWikiUpdate({ proposalId: applied.id, repoUrl: 'https://example.invalid/wiki.git' });
  const storedCard: KnowledgeCard = upsertKnowledgeCard(card);
  const obsidianAdapter: WikiAdapter = new ObsidianVaultAdapter('/tmp/wiki');
  const githubAdapter: WikiAdapter = new GitHubWikiGitAdapter({ repoUrl: 'https://example.invalid/wiki.git', localPath: '/tmp/wiki-git' });
  void [adapted, obsidian, github, storedCard, obsidianAdapter, githubAdapter];
}

const knowledgeCardInput: Omit<KnowledgeCard, 'id' | 'updatedAt'> = {
  type: 'procedure',
  product: 'HCI',
  title: 'MTU check',
  prerequisites: [],
  steps: [],
  warnings: [],
  verification: [],
  rollback: [],
  citations: [{ sourceId: 'manual', spanText: 'MTU', quoteHash: 'a'.repeat(64) }],
  trustLevel: 'internal',
};
const inertAdapter: WikiAdapter = {
  readPage: async () => '',
  writePage: async (path, _content, message) => ({ ok: true, path, message }),
};

const savedEnvironment = { ...process.env };
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'public-api-write-compat-'));
  process.env.SANGFOR_FEEDBACK_ROOT = join(root, 'feedback');
  process.env.SANGFOR_WIKI_ROOT = join(root, 'wiki');
});

afterEach(() => {
  process.env = { ...savedEnvironment };
  rmSync(root, { recursive: true, force: true });
});

describe('legacy local-write public API cutover', () => {
  it('keeps the origin/main consumer contract compilable', () => {
    // Given the origin/main consumer declarations above.
    // When TypeScript compiles this test module.
    // Then every legacy call retains its shipped input and return type.
    expect(originMainConsumerCompiles).toBeTypeOf('function');
  });

  it('refuses a legacy feedback write synchronously without creating storage', () => {
    // Given a legacy one-argument feedback consumer and an empty data root.
    // When it invokes the old write API without authority.
    // Then migration is required and no write occurs.
    expect(() => submitFeedback(feedbackInput)).toThrow(/submitFeedbackWithAuthority/);
    expect(existsSync(process.env.SANGFOR_FEEDBACK_ROOT ?? '')).toBe(false);
  });

  it('refuses legacy lesson extraction synchronously without creating storage', () => {
    // Given a legacy lesson consumer and an empty data root.
    // When it invokes extraction without authority.
    // Then migration is required and no write occurs.
    expect(() => extractLesson('feedback_missing')).toThrow(/extractLessonWithAuthority/);
    expect(existsSync(process.env.SANGFOR_FEEDBACK_ROOT ?? '')).toBe(false);
  });

  it.each([
    ['proposal', () => proposeWikiUpdate({ lessonTitle: 'Lesson', lessonBody: 'Body' }), /proposeWikiUpdateWithAuthority/],
    ['approval', () => approveWikiUpdate('proposal', 'rejected'), /approveWikiUpdateWithAuthority/],
    ['plain apply', () => applyWikiUpdate('proposal'), /applyWikiUpdateWithAuthority/],
    ['knowledge card', () => upsertKnowledgeCard(knowledgeCardInput), /upsertKnowledgeCardWithAuthority/],
  ])('refuses the legacy synchronous wiki %s API without storage', (_name, invoke, replacement) => {
    // Given a legacy synchronous wiki consumer and an empty data root.
    // When it invokes a write without authority.
    // Then migration is required and no storage is created.
    expect(invoke).toThrow(replacement);
    expect(existsSync(process.env.SANGFOR_WIKI_ROOT ?? '')).toBe(false);
  });

  it.each([
    ['adapter apply', () => applyWikiUpdateWithAdapter('proposal', inertAdapter), /applyWikiUpdateWithAdapterAndAuthority/],
    ['Obsidian apply', () => applyObsidianWikiUpdate({ proposalId: 'proposal', vaultPath: join(root, 'vault') }), /applyObsidianWikiUpdateWithAuthority/],
    ['GitHub apply', () => applyGitHubWikiUpdate({ proposalId: 'proposal', repoUrl: 'https://example.invalid/wiki.git' }), /applyGitHubWikiUpdateWithAuthority/],
    ['Obsidian adapter write', () => new ObsidianVaultAdapter(join(root, 'vault')).writePage('Page', 'body', 'message'), /ObsidianVaultAdapter/],
    ['GitHub adapter sync', () => new GitHubWikiGitAdapter({ repoUrl: 'https://example.invalid/wiki.git', localPath: join(root, 'git') }).readPage('Page'), /GitHubWikiGitAdapter/],
  ])('refuses the legacy asynchronous wiki %s API without storage', async (_name, invoke, replacement) => {
    // Given a legacy asynchronous wiki consumer and an empty data root.
    // When it invokes a write or local sync without authority.
    // Then migration is required and no storage is created.
    await expect(invoke()).rejects.toThrow(replacement);
    expect(existsSync(process.env.SANGFOR_WIKI_ROOT ?? '')).toBe(false);
  });
});

describe('authority-bound local-write public API', () => {
  it('submits feedback and extracts a lesson through explicit authority APIs', async () => {
    // Given matching authority for the engagement-scoped feedback root.
    const authority = testLocalWriteAuthority('feedback_lessons');

    // When feedback and lesson writes use the explicit authority APIs.
    const feedback = await submitFeedbackWithAuthority(feedbackInput, authority);
    const lesson = await extractLessonWithAuthority(feedback.id, authority);

    // Then both writes complete with their domain states.
    expect(feedback.status).toBe('new');
    expect(lesson.feedbackId).toBe(feedback.id);
  });

  it('creates a pending wiki proposal through the explicit authority API', async () => {
    // Given matching authority for the wiki proposal root.
    const authority = testLocalWriteAuthority('wiki_proposals');

    // When a proposal uses the explicit authority API.
    const proposal = await proposeWikiUpdateWithAuthority({ lessonTitle: 'Lesson', lessonBody: 'Body' }, authority);

    // Then the authorized write creates only a pending proposal.
    expect(proposal.status).toBe('pending');
  });
});
