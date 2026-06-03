import { nowId, normalizeProduct } from '@sangfor/shared';

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

const feedback = new Map<string, FeedbackEvent>();
const lessons = new Map<string, LessonLearned>();

export function submitFeedback(input: Omit<FeedbackEvent, 'id' | 'status'>): FeedbackEvent {
  const event: FeedbackEvent = { ...input, product: normalizeProduct(input.product).toString(), id: nowId('feedback'), status: 'new' };
  feedback.set(event.id, event);
  return event;
}

export function extractLesson(feedbackId: string): LessonLearned {
  const event = feedback.get(feedbackId);
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
  lessons.set(lesson.id, lesson);
  event.status = 'lesson_extracted';
  return lesson;
}

export function listLessons(): LessonLearned[] {
  return [...lessons.values()];
}
