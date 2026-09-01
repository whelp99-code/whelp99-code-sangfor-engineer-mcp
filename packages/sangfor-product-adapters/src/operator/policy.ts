import { isIP } from 'node:net';
import { getDomain } from 'tldts';
import type { GroundedIagMutationAction } from '../apply/iag-mutation-action.js';

export function isNarrowReversibleIagAction(action: GroundedIagMutationAction): boolean {
  switch (action.intent.kind) {
    case 'URL_DOMAIN_EXCEPTION': {
      const value = action.intent.value;
      return !value.includes('*')
        && (isIP(value) !== 0 || getDomain(value, { allowPrivateDomains: true }) !== null);
    }
    case 'APPLICATION_EXCEPTION':
      return action.intent.applicationId.length > 0;
    default:
      action.intent satisfies never;
      return false;
  }
}
