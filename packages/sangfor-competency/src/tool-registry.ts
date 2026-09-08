/**
 * The canonical live tool census used to ground every replacement claim.
 *
 * There is exactly one honest answer to "is this tool registered": the one the
 * running server gives. The http-bridge already publishes it verbatim at
 * `GET /tools` (it proxies `tools/list` over the stdio child), so every surface
 * that is not itself the MCP server reads the census from there. A comma-list in
 * an env var is not a census — whoever sets it decides what counts as real, which
 * is how an invented tool name used to certify a replacement.
 */
import { z } from 'zod';
import { violation, type CoverageViolation } from './violations.js';

/**
 * The JSON Schema subset the live server actually emits for `inputSchema`,
 * closed at every level and bounded in depth.
 *
 * The bound is deliberate. An openly recursive `z.lazy()` lets the payload decide
 * how deep this process recurses, so a 1,000-level census would drive validation
 * 1,000 frames down before deciding anything — the validator becomes the
 * liability it exists to remove. Instead the schema is built bottom-up to the
 * depth the real server actually emits (five property/item hops below the
 * inputSchema root, measured across the live 115-tool census), and the terminal
 * level declares no `properties`/`items` at all, so a sixth hop is simply an
 * unknown key. Depth is a property of the type, not of the input.
 */
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean'] as const;

/** Measured from the live census; tests/competency-registry-depth-bound.test.ts fails if the server outgrows it. */
const MAX_SCHEMA_DEPTH = 5;

interface JsonSchemaNode {
  readonly type?: (typeof SCHEMA_TYPES)[number];
  readonly description?: string;
  readonly default?: string | boolean;
  readonly enum?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly items?: JsonSchemaNode;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly pattern?: string;
}

const LEAF_FIELDS = {
  type: z.enum(SCHEMA_TYPES).optional(),
  description: z.string().optional(),
  default: z.union([z.string(), z.boolean()]).optional(),
  enum: z.array(z.string()).readonly().optional(),
  required: z.array(z.string()).readonly().optional(),
  additionalProperties: z.boolean().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minItems: z.number().int().optional(),
  pattern: z.string().optional(),
} as const;

/** Terminal depth: `properties` and `items` are undeclared here, so a further hop is an unknown key. */
const terminalNode: z.ZodType<JsonSchemaNode> = z.object(LEAF_FIELDS).strict();

const nestOnce = (child: z.ZodType<JsonSchemaNode>): z.ZodType<JsonSchemaNode> =>
  z.object({ ...LEAF_FIELDS, properties: z.record(child).optional(), items: child.optional() }).strict();

const jsonSchemaNodeSchema: z.ZodType<JsonSchemaNode> = Array.from({ length: MAX_SCHEMA_DEPTH })
  .reduce<z.ZodType<JsonSchemaNode>>((child) => nestOnce(child), terminalNode);

const bridgeToolsSchema = z.object({
  tools: z.array(z.object({
    name: z.string().trim().min(1),
    description: z.string(),
    inputSchema: jsonSchemaNodeSchema,
    annotations: z.object({
      title: z.string().min(1),
      readOnlyHint: z.boolean(),
      destructiveHint: z.boolean(),
    }).strict().readonly(),
    category: z.string().min(1),
  }).strict().readonly()).readonly(),
}).strict();

export type ToolRegistryLoad =
  | { readonly ok: true; readonly toolNames: readonly string[] }
  | { readonly ok: false; readonly violations: readonly CoverageViolation[] };

/** A caller supplies one of these; it is the only way to obtain a grounding census. */
export type ToolRegistrySource = () => Promise<ToolRegistryLoad>;

/** Matches the bridge default documented in apps/http-bridge and control-tower's client. */
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3600';

export const bridgeUrlFromEnv = (): string =>
  process.env.SANGFOR_HTTP_BRIDGE_URL?.trim() || DEFAULT_BRIDGE_URL;

export async function fetchBridgeToolRegistry(
  baseUrl: string = bridgeUrlFromEnv(),
  token: string | undefined = process.env.SANGFOR_API_TOKEN,
): Promise<ToolRegistryLoad> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  let body: unknown;
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/u, '')}/tools`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      return { ok: false, violations: [violation('registryUnreachable', null, `bridge ${baseUrl} answered HTTP ${res.status}`)] };
    }
    body = await res.json();
  } catch (error) {
    return {
      ok: false,
      violations: [violation('registryUnreachable', null, `bridge ${baseUrl} is unreachable (${error instanceof Error ? error.message : 'unknown error'})`)],
    };
  }

  const parsed = bridgeToolsSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      violations: parsed.error.issues.map((issue) =>
        violation('schemaInvalid', null, `bridge /tools: ${issue.path.join('.') || '<root>'} ${issue.message}`)),
    };
  }

  const toolNames = parsed.data.tools.map((t) => t.name);
  if (toolNames.length === 0) {
    // An empty census cannot ground anything, and treating it as "nothing is
    // registered" would silently refuse every claim for the wrong reason.
    return { ok: false, violations: [violation('unregisteredTool', null, `bridge ${baseUrl} advertises no tools`)] };
  }
  return { ok: true, toolNames };
}
