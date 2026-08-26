import { AuthorityCutoverError } from './errors.js';
import { CutoverState, type CutoverAggregateState, type CutoverCommand } from './types.js';

function conflict(): never {
  throw new AuthorityCutoverError('CUTOVER_STATE_CONFLICT');
}

export function transitionCutover(
  current: CutoverAggregateState,
  command: CutoverCommand,
): CutoverAggregateState {
  if (command.expectedRevision !== undefined && command.expectedRevision !== current.revision) {
    throw new AuthorityCutoverError('CUTOVER_STALE_REVISION');
  }
  const revision = current.revision + 1;
  switch (command.kind) {
    case 'START_BACKFILL':
      if (current.state === CutoverState.BACKFILLING && current.sourceHighWaterMark === command.highWaterMark) return current;
      if (current.state !== CutoverState.LOCAL_PRIMARY) return conflict();
      return { ...current, state: CutoverState.BACKFILLING, revision, sourceHighWaterMark: command.highWaterMark };
    case 'VERIFY_BACKFILL':
      if (command.sourceDigest !== command.targetDigest) throw new AuthorityCutoverError('CUTOVER_PARITY_MISMATCH');
      if (current.state === CutoverState.SHADOW_READING
        && current.sourceDigest === command.sourceDigest && current.targetDigest === command.targetDigest) return current;
      if (current.state !== CutoverState.BACKFILLING) return conflict();
      return { ...current, state: CutoverState.SHADOW_READING, revision, sourceDigest: command.sourceDigest, targetDigest: command.targetDigest };
    case 'FREEZE':
      if (current.state === CutoverState.FROZEN && current.localWriteFencedAt === command.at) return current;
      if (current.state !== CutoverState.SHADOW_READING) return conflict();
      return { ...current, state: CutoverState.FROZEN, revision, localWriteFencedAt: command.at };
    case 'PROMOTE':
      if (current.state === CutoverState.POSTGRES_PRIMARY) return current;
      if (current.state !== CutoverState.FROZEN) return conflict();
      return { ...current, state: CutoverState.POSTGRES_PRIMARY, revision, epoch: current.epoch + 1 };
    case 'ROLLBACK':
      if (current.state === CutoverState.FROZEN || current.state === CutoverState.POSTGRES_PRIMARY) {
        throw new AuthorityCutoverError('CUTOVER_ROLLBACK_REFUSED');
      }
      if (current.state === CutoverState.LOCAL_PRIMARY) return current;
      return {
        ...current, state: CutoverState.LOCAL_PRIMARY, revision,
        sourceHighWaterMark: null, sourceDigest: null, targetDigest: null, localWriteFencedAt: null,
      };
    default:
      command satisfies never;
      return conflict();
  }
}
