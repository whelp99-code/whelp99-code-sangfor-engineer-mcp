import { z } from 'zod';

const MAX_JSON_STRING_LENGTH = 16 * 1024 * 1024;
const MAX_JSON_ARRAY_LENGTH = 250_000;
const MAX_JSON_KEY_LENGTH = 1_024;

export type RuntimeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RuntimeJsonValue[]
  | { readonly [key: string]: RuntimeJsonValue };

export const runtimeJsonValueSchema: z.ZodType<RuntimeJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(MAX_JSON_STRING_LENGTH),
  z.array(runtimeJsonValueSchema).max(MAX_JSON_ARRAY_LENGTH),
  z.record(z.string().min(1).max(MAX_JSON_KEY_LENGTH), runtimeJsonValueSchema),
]));

export const runtimeJsonObjectSchema = z.record(
  z.string().min(1).max(MAX_JSON_KEY_LENGTH),
  runtimeJsonValueSchema,
);
