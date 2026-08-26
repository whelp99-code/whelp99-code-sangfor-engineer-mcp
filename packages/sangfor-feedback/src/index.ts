import { nowId, normalizeProduct, expectedLocalWriteScope, requireLocalWriteAuthority, resolveEngagementScopedData, appendJsonl, foldJsonlById, type LocalWriteAuthority } from '@sangfor/shared';
import { join } from 'node:path';

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

export async function submitFeedback(input: Omit<FeedbackEvent, 'id' | 'status'>, injectedAuthority: LocalWriteAuthority): Promise<FeedbackEvent> {
  const event: FeedbackEvent = { ...input, product: normalizeProduct(input.product).toString(), id: nowId('feedback'), status: 'new' };
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority?.projectId ?? '', 'feedback_lessons', dir(),
  ));
  await authority.fence.write(authority, { operation: 'feedback.submit', targetPaths: [feedbackFile()] }, () => appendJsonl(feedbackFile(), event));
  return event;
}

export async function extractLesson(feedbackId: string, injectedAuthority: LocalWriteAuthority): Promise<LessonLearned> {
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority?.projectId ?? '', 'feedback_lessons', dir(),
  ));
  return authority.fence.write(authority, { operation: 'feedback.extract-lesson', targetPaths: [feedbackFile(), lessonsFile()] }, () => {
  const event = foldJsonlById<FeedbackEvent>(feedbackFile()).get(feedbackId);
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

export function listLessons(): LessonLearned[] {
  return [...foldJsonlById<LessonLearned>(lessonsFile()).values()];
}
