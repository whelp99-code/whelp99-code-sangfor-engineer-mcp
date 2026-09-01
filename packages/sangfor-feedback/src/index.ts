import { nowId, normalizeProduct, expectedLocalWriteScope, requireLocalWriteAuthority, resolveEngagementScopedData, appendJsonl, foldJsonlById, type LocalWriteAuthority } from '@sangfor/shared';
import { join } from 'node:path';
import { feedbackEventCodec, lessonLearnedCodec } from './runtime-codecs.js';

export interface FeedbackEvent {
  id: string;
  product: string;
  feedbackType: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  feedbackText: string;
  sourceRole: 'user' | 'engineer' | 'codex' | 'verifier' | 'customer';
  status: 'new' | 'lesson_extracted' | 'closed';
}

export interface LessonLearned {
  id: string;
  feedbackId: string;
  product: string;
  lessonTitle: string;
  lessonBody: string;
  rootCause: string;
  recommendedAction: string;
  antiPattern: string;
  approvalStatus: 'pending_review' | 'approved' | 'rejected';
}

// Engagement-scoped: apps/mcp-server reads this same root through
// resolveEngagementScopedData, so resolving it unscoped here would make the
// package write into a different partition than the server reads.
const dir = () => resolveEngagementScopedData('data/feedback', 'SANGFOR_FEEDBACK_ROOT');
const feedbackFile = () => join(dir(), 'feedback.jsonl');
const lessonsFile = () => join(dir(), 'lessons.jsonl');

export class LegacyFeedbackWriteApiError extends Error {
  readonly name = 'LegacyFeedbackWriteApiError';

  constructor(readonly legacyApi: string, readonly replacementApi: string) {
    super(`${legacyApi} requires explicit local write authority; use ${replacementApi}.`);
  }
}

export function submitFeedback(input: Omit<FeedbackEvent, 'id' | 'status'>): FeedbackEvent;
export function submitFeedback(input: Omit<FeedbackEvent, 'id' | 'status'>, injectedAuthority: LocalWriteAuthority): Promise<FeedbackEvent>;
export function submitFeedback(
  input: Omit<FeedbackEvent, 'id' | 'status'>,
  injectedAuthority?: LocalWriteAuthority,
): FeedbackEvent | Promise<FeedbackEvent> {
  if (!injectedAuthority) throw new LegacyFeedbackWriteApiError('submitFeedback', 'submitFeedbackWithAuthority');
  const event: FeedbackEvent = { ...input, product: normalizeProduct(input.product).toString(), id: nowId('feedback'), status: 'new' };
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority.projectId, 'feedback_lessons', dir(),
  ));
  return authority.fence.write(authority, { operation: 'feedback.submit', targetPaths: [feedbackFile()] }, () => {
    appendJsonl(feedbackFile(), event);
    return event;
  });
}

export function submitFeedbackWithAuthority(
  input: Omit<FeedbackEvent, 'id' | 'status'>,
  authority: LocalWriteAuthority,
): Promise<FeedbackEvent> {
  return submitFeedback(input, authority);
}

export function extractLesson(feedbackId: string): LessonLearned;
export function extractLesson(feedbackId: string, injectedAuthority: LocalWriteAuthority): Promise<LessonLearned>;
export function extractLesson(
  feedbackId: string,
  injectedAuthority?: LocalWriteAuthority,
): LessonLearned | Promise<LessonLearned> {
  if (!injectedAuthority) throw new LegacyFeedbackWriteApiError('extractLesson', 'extractLessonWithAuthority');
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority.projectId, 'feedback_lessons', dir(),
  ));
  return authority.fence.write(authority, { operation: 'feedback.extract-lesson', targetPaths: [feedbackFile(), lessonsFile()] }, () => {
    const event = foldJsonlById(feedbackFile(), feedbackEventCodec).get(feedbackId);
    if (!event) throw new Error(`Unknown feedback: ${feedbackId}`);
    const lesson: LessonLearned = {
      id: nowId('lesson'),
      feedbackId,
      product: event.product,
      lessonTitle: `${event.product} lesson from ${event.feedbackType}`,
      lessonBody: event.feedbackText,
      rootCause: 'MVP extractor: root cause should be reviewed by senior engineer.',
      recommendedAction: 'Add this lesson to config planner precheck, validation or rollback template after review.',
      antiPattern: 'Do not promote unreviewed feedback directly into configuration plan.',
      approvalStatus: 'pending_review'
    };
    appendJsonl(lessonsFile(), lesson);
    appendJsonl(feedbackFile(), { ...event, status: 'lesson_extracted' });
    return lesson;
  });
}

export function extractLessonWithAuthority(feedbackId: string, authority: LocalWriteAuthority): Promise<LessonLearned> {
  return extractLesson(feedbackId, authority);
}

export function listLessons(): LessonLearned[] {
  return [...foldJsonlById(lessonsFile(), lessonLearnedCodec).values()];
}
