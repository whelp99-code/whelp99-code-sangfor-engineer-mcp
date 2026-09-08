import { getToolHandler } from './tool-registry.js';

export const SAFETY_POSTURE = {
  default: 'dry-run / read-only',
  liveWriteRequires: ['SANGFOR_ALLOW_REAL_EXECUTION', 'signed action-bound single-use approval'],
  productionAlsoRequires: ['SANGFOR_ALLOW_PRODUCTION_EXECUTION'],
  indeterminateIsNeverPass: true,
  irreversibleActsStayHuman: true,
};

const RESOURCES: Array<{ uri: string; name: string; description: string; mimeType: string; build: () => unknown }> = [
  { uri: 'sangfor://agent-manifest', name: 'Agent manifest', description: 'Recommended first calls and standard tool groups for agent self-onboarding.', mimeType: 'application/json', build: () => getToolHandler('sangfor_agent_manifest')?.({}) },
  { uri: 'sangfor://capabilities', name: 'Server capabilities', description: 'Tool categories, supported vendors/products, and execution posture.', mimeType: 'application/json', build: () => getToolHandler('sangfor_capabilities')?.({}) },
  { uri: 'sangfor://safety/posture', name: 'Safety posture', description: 'Read-only-by-default execution model and the gates a live write must clear.', mimeType: 'application/json', build: () => SAFETY_POSTURE },
];

export function listResources() {
  return RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType }));
}

export function readResource(uri: string) {
  const r = RESOURCES.find((x) => x.uri === uri);
  if (!r) throw new Error(`Unknown resource: ${uri}`);
  return { contents: [{ uri, mimeType: r.mimeType, text: JSON.stringify(r.build(), null, 2) }] };
}
