/** Mint a SignedApproval for an HCI write. Usage:
 *  SANGFOR_OPERATOR_APPROVAL_SECRET=... pnpm exec tsx scripts/mint-hci-approval.ts \
 *    --type hci.create-volume --target 127.0.0.1:vol-a --approvedBy jmpark \
 *    --ticket CHG-123 --rollback RB-123 --ttlSec 300
 */
import { randomBytes } from 'node:crypto';
import { signApprovalToken } from '../packages/sangfor-operator/src/approval.js';

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};

const secret = process.env.SANGFOR_OPERATOR_APPROVAL_SECRET;
if (!secret) {
  console.error('SANGFOR_OPERATOR_APPROVAL_SECRET is required (fail-closed).');
  process.exit(1);
}

const action = { type: arg('type', 'hci.create-volume')!, target: arg('target') };
if (!action.target) {
  console.error('--target is required (host:name or host:volumeId).');
  process.exit(1);
}

const base = {
  approvedBy: arg('approvedBy', 'unknown')!,
  changeTicketId: arg('ticket', '')!,
  rollbackPlanId: arg('rollback', '')!,
  nonce: randomBytes(12).toString('hex'),
  expiresAt: new Date(Date.now() + Number(arg('ttlSec', '300')) * 1000).toISOString(),
};

console.log(JSON.stringify({ ...base, approvalToken: signApprovalToken(secret, action, base) }, null, 2));
