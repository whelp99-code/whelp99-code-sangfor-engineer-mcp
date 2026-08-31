import { createHash } from 'node:crypto';

export const JM_TENANT_ID = 'task26-tenant';
export const JM_PROJECT_ID = 'task26-project';
export const JM_INSTALLATION_ID = 'task26-installation';
export const JM_CLIENT_IDENTITY_ID = 'client:task26-installation';
export const JM_ORIGIN = 'https://console.task26.invalid';
export const JM_DEVICE_DIGEST = createHash('sha256').update('task26-device').digest('hex');
export const JM_SESSION_ID = 'task26-session';

export const JM_JOURNAL_GENESIS = createHash('sha256')
  .update('task26-journal-genesis').digest('hex');

export function originDigest(origin: string): string {
  return createHash('sha256').update(`sangfor.origin.v1\u0000${origin}`, 'utf8').digest('hex');
}
