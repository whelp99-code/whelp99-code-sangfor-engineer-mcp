import { describe, expect, it } from 'vitest';
import { classifyProduct, reconcileChunks, titleVersion } from '../scripts/build-issue-16-eval-indexes.mjs';

describe('issue #16 evaluation-index reconciliation', () => {
  it('classifies supported products and extracts title versions deterministically', () => {
    expect(classifyProduct({ product: 'OTHER', title: 'Athena NGFW 8.0.107 - User Manual' })).toBe('NGFW');
    expect(classifyProduct({ product: 'OTHER', title: 'Sangfor Data Center Cloud (SCC) 2.6.0' })).toBe('SCC');
    expect(titleVersion('HCI 6.11.1R1 - User Manual')).toBe('6.11.1R1');
    expect(titleVersion('1.1.1.0/24 Network Segment Cannot Access Internet')).toBeUndefined();
    expect(titleVersion('Internal Device Unable To Ping 8.8.8.8')).toBeUndefined();
  });

  it('removes orphaned chunks and preserves deterministic output', () => {
    const chunks = [
      { id: 'kept', filePath: 'kept.md', product: 'OTHER', title: 'Athena NGFW 8.0.107 - User Manual' },
      { id: 'orphan', filePath: '/missing/external.md', product: 'HCI', title: 'External note' }
    ];
    const first = reconcileChunks(chunks, (path: string) => path === 'kept.md');
    const second = reconcileChunks(chunks, (path: string) => path === 'kept.md');
    expect(first).toEqual(second);
    expect(first.orphanChunksRemoved).toBe(1);
    expect(first.productCorrections).toBe(1);
    expect(first.versionCorrections).toBe(1);
    expect(first.chunks).toEqual([expect.objectContaining({ id: 'kept', product: 'NGFW', version: '8.0.107' })]);
  });
});
