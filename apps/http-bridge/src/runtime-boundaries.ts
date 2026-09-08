import { z } from 'zod';
import { runtimeJsonObjectSchema, runtimeJsonValueSchema } from '../../../packages/shared/src/runtime-json-codecs.js';
import { parseRuntimeJson, type RuntimeCodec } from '../../../packages/shared/src/runtime-schema.js';
import { hasApprovalControlCharacters } from '../../../packages/sangfor-approval/src/index.js';
import type { JsonRpcResponse } from './mcp-child-transport.js';

const responseIdSchema = z.union([z.string().max(512), z.number().finite(), z.null()]);

// JSON-RPC 2.0 §5: a response carries `result` or `error` — never both, never
// neither. Modelling that as a union means a frame the child could not answer
// definitively is rejected here, so the waiting caller is failed loudly instead
// of resolved with an absent result that reads like a successful empty answer.
const responseSchema = z.union([
  z.object({
    jsonrpc: z.literal('2.0'),
    id: responseIdSchema,
    result: runtimeJsonValueSchema,
  }).strict(),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: responseIdSchema,
    error: z.object({
      code: z.number().int(),
      message: z.string().max(1_000_000),
    }).strict(),
  }).strict(),
]);

export function parseBoundaryHttpBridgeResponseV1(source: string): JsonRpcResponse {
  return parseRuntimeJson(source, {
    schema: responseSchema,
    schemaName: 'http-bridge.json-rpc-response.v1',
    policy: 'INDETERMINATE',
  });
}

const approvalTextSchema = z.string().max(4_096).refine((value) => !hasApprovalControlCharacters(value));

const signedApprovalSchema = z.object({
  approvedBy: approvalTextSchema,
  approvalToken: approvalTextSchema,
  changeTicketId: approvalTextSchema,
  rollbackPlanId: approvalTextSchema,
  nonce: approvalTextSchema,
  expiresAt: z.string().max(128).refine((value) => !hasApprovalControlCharacters(value)),
  authorityEpoch: z.number().int().nonnegative(),
}).strict();

const toolsCallBodySchema = z.object({
  name: z.string().max(4_096).optional(),
  arguments: runtimeJsonValueSchema.optional(),
  args: runtimeJsonValueSchema.optional(),
  approval: signedApprovalSchema.optional(),
}).strict();

const mcpToolCallParamsSchema = z.object({
  name: z.string().max(4_096).optional(),
  arguments: runtimeJsonValueSchema.optional(),
  approval: signedApprovalSchema.optional(),
}).strict();

const mcpRequestBodySchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: responseIdSchema.optional(),
  method: z.string().max(4_096),
  params: runtimeJsonObjectSchema.optional(),
}).strict().superRefine((request, context) => {
  if (request.method !== 'tools/call') return;
  const parsed = mcpToolCallParamsSchema.safeParse(request.params ?? {});
  if (!parsed.success) context.addIssue({ code: z.ZodIssueCode.custom });
});

export type HttpBridgeToolsCallBody = z.output<typeof toolsCallBodySchema>;
export type HttpBridgeMcpRequestBody = z.output<typeof mcpRequestBodySchema>;
export type HttpBridgeRequestBody = HttpBridgeToolsCallBody | HttpBridgeMcpRequestBody;

export function decodeHttpBridgeToolCallParams(
  value: unknown,
): z.output<typeof mcpToolCallParamsSchema> {
  return mcpToolCallParamsSchema.parse(value);
}

export function decodeHttpBridgeToolsListResult(
  value: unknown,
): { readonly tools: readonly unknown[] } {
  return z.object({
    tools: z.array(runtimeJsonValueSchema).max(100_000),
    nextCursor: z.string().max(4_096).optional(),
  }).strict().parse(value);
}

export function decodeHttpBridgeToolsCallBody(value: HttpBridgeRequestBody): HttpBridgeToolsCallBody {
  return toolsCallBodySchema.parse(value);
}

export function decodeHttpBridgeMcpRequestBody(value: HttpBridgeRequestBody): HttpBridgeMcpRequestBody {
  return mcpRequestBodySchema.parse(value);
}

export function parseBoundaryHttpBridgeRequestBodyV1(source: string): HttpBridgeRequestBody {
  const schema: RuntimeCodec<HttpBridgeRequestBody> = z.union([
    toolsCallBodySchema,
    mcpRequestBodySchema,
  ]);
  return parseRuntimeJson(source, {
    schema,
    schemaName: 'http-bridge.request-body.v1',
    policy: 'deny',
  });
}
