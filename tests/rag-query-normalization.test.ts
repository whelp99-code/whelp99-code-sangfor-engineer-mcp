import { describe, expect, it } from 'vitest';
import { normalizeRetrievalQuery } from '../packages/sangfor-rag/src/query-normalization.js';

describe('normalizeRetrievalQuery', () => {
  it.each([
    ['제한 대역폭 채널을 설정하는 방법', 'limited bandwidth channel'],
    ['테넌트 예약 백업 작업 구성', 'scheduled backup policy'],
    ['HCI 분산 방화벽 정책', 'distributed firewall'],
    ['서버와 네트워크 환경 요구사항', 'environment requirements'],
    ['가상 iSCSI 스토리지', 'virtual iSCSI'],
    ['보장 대역폭 채널 설정', 'guaranteed bandwidth channel'],
    ['자동 격리 정책', 'automatic isolation'],
    ['클러스터 상태 확인', 'status check']
  ])('adds stable English corpus terminology for %s', (query, expected) => {
    const normalized = normalizeRetrievalQuery(query);
    expect(normalized).toContain(query);
    expect(normalized).toContain(expected);
  });

  it('does not alter an English query without a known bilingual term', () => {
    expect(normalizeRetrievalQuery('HCI API reference')).toBe('HCI API reference');
  });

  it('expands each matching term only once', () => {
    expect(normalizeRetrievalQuery('상태 확인 후 상태를 확인')).toBe(
      '상태 확인 후 상태를 확인 status check'
    );
  });
});
