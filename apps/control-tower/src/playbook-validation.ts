// 플레이북 블록의 fail-closed 검증과 저장 전 비밀 마스킹.

import { maskSecrets } from '../../../packages/sangfor-runs/src/index.js';
import type { PlaybookBlock } from './playbook-types.js';

// status를 실어 api 계층이 400/404/409로 매핑 (RegistryValidationError는 항상 400이었지만
// 플레이북은 상태기계 위반=409, 미존재=404를 구분해야 한다).
export class PlaybookValidationError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

// create/addRevision 시 fail-closed 검증.
export function validateBlocks(blocks: PlaybookBlock[]): void {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new PlaybookValidationError('blocks는 비어있을 수 없습니다');
  }
  const seen = new Set<string>();
  let reportCount = 0;
  for (const b of blocks) {
    if (!b.id?.trim()) throw new PlaybookValidationError('block.id는 필수입니다');
    if (seen.has(b.id)) throw new PlaybookValidationError(`중복 block.id: ${b.id}`);
    seen.add(b.id);
    if (b.type === 'tool') {
      if (!b.toolId?.trim()) throw new PlaybookValidationError(`tool 블록 '${b.id}'에 toolId가 없습니다`);
      // 플레이북 프록시 도구(MCP sangfor_playbook_*)를 블록으로 두면 플레이북이 플레이북을
      // 호출한다 — 중첩 실행은 설계 비범위이므로 저장 단계에서 막는다.
      if (b.toolId.startsWith('sangfor_playbook_')) {
        throw new PlaybookValidationError(`블록에 플레이북 프록시 도구를 쓸 수 없습니다(중첩 실행 비범위): ${b.toolId}`);
      }
    } else if (b.type === 'report') {
      if (b.toolId !== undefined || b.args !== undefined) {
        throw new PlaybookValidationError(`report 블록 '${b.id}'에는 toolId/args를 둘 수 없습니다`);
      }
      reportCount += 1;
    } else {
      throw new PlaybookValidationError(`알 수 없는 block.type: ${String((b as PlaybookBlock).type)}`);
    }
  }
  if (reportCount > 1) throw new PlaybookValidationError('report 블록은 최대 1개입니다');
}

export function maskBlocks(blocks: PlaybookBlock[]): PlaybookBlock[] {
  return blocks.map((b) => (b.args ? { ...b, args: maskSecrets(b.args) } : b));
}
