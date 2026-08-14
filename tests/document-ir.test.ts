import { describe, expect, it } from 'vitest';
import { extractDocumentBlocks } from '../packages/sangfor-rag/src/document-ir.js';

describe('extractDocumentBlocks', () => {
  it('strips front matter and emits heading-aware blocks with stable metadata', () => {
    const blocks = extractDocumentBlocks({
      sourceId: 'raw/hci.md',
      text: [
        '---',
        'product: HCI',
        'version: 6.12',
        'contentHash: rev-1',
        '---',
        '# Storage Network',
        '',
        '## MTU Warning',
        '',
        'Warning: keep storage MTU consistent before cluster initialization.',
        '',
        '```',
        'show network mtu',
        '```'
      ].join('\n')
    });

    expect(blocks.map((block) => block.blockType)).toEqual(['heading', 'heading', 'warning', 'code']);
    expect(blocks[2].headingPath).toEqual(['Storage Network', 'MTU Warning']);
    expect(blocks[2].product).toBe('HCI');
    expect(blocks[2].version).toBe('6.12');
    expect(blocks[2].sourceRevision).toBe('rev-1');
    expect(blocks[2].text).not.toContain('contentHash');
  });
});
