import {
  authorizeToolCall,
  type ToolAuthDecision,
} from '../../../packages/sangfor-operator/src/tool-authorization.js';

export function authorizeSafetySelftestToolCall(
  params: Parameters<typeof authorizeToolCall>[0],
): Promise<ToolAuthDecision> {
  return authorizeToolCall(params);
}
