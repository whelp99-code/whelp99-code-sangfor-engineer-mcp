import { z } from 'zod';
import type { NamedRuntimeCodec } from '../../shared/src/runtime-schema.js';
import type { FeedbackEvent, LessonLearned } from './index.js';

const idSchema = z.string().min(1).max(512);
const textSchema = z.string().max(16 * 1024 * 1024);

export const feedbackEventCodec: NamedRuntimeCodec<FeedbackEvent> = {
  schema: z.object({
    id: idSchema,
    product: idSchema,
    feedbackType: idSchema,
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    feedbackText: textSchema,
    sourceRole: z.enum(['user', 'engineer', 'codex', 'verifier', 'customer']),
    status: z.enum(['new', 'lesson_extracted', 'closed']),
  }).strict(),
  schemaName: 'feedback.event.v1',
};

export const lessonLearnedCodec: NamedRuntimeCodec<LessonLearned> = {
  schema: z.object({
    id: idSchema,
    feedbackId: idSchema,
    product: idSchema,
    lessonTitle: textSchema,
    lessonBody: textSchema,
    rootCause: textSchema,
    recommendedAction: textSchema,
    antiPattern: textSchema,
    approvalStatus: z.enum(['pending_review', 'approved', 'rejected']),
  }).strict(),
  schemaName: 'feedback.lesson.v1',
};
