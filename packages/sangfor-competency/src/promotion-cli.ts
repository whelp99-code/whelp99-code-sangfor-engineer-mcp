import type { CapabilityPromotionResult } from './promotion.js';

export type CapabilityPromotionCliOutput = {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
};

export function capabilityPromotionCliOutput(result: CapabilityPromotionResult): CapabilityPromotionCliOutput {
  switch (result.status) {
    case 'applied':
      return { exitCode: 0, stdout: 'CAPABILITY_PROMOTION_APPLIED\n', stderr: '' };
    case 'refused':
      return {
        exitCode: 1,
        stdout: '',
        stderr: `${JSON.stringify({ status: 'refused', message: 'CAPABILITY_PROMOTION_REFUSED', refusalCode: result.refusalCode })}\n`,
      };
    case 'indeterminate':
      return { exitCode: 2, stdout: '', stderr: 'CAPABILITY_PROMOTION_INDETERMINATE\n' };
    default:
      result satisfies never;
      return { exitCode: 2, stdout: '', stderr: 'CAPABILITY_PROMOTION_INDETERMINATE\n' };
  }
}
