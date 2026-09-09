import { describe, expect, it } from 'vitest';
import { joinOverlappingChunks, stripSupportChrome, structuredChunks } from '../packages/sangfor-rag/src/structured-chunks.js';

describe('structured document preparation', () => {
  it('joins exact overlap but never erases an uncertain gap', () => {
    const overlap = 'Repeated overlap with at least thirty-two characters.';
    expect(joinOverlappingChunks(['First '+overlap, overlap+' Last'])).toBe('First '+overlap+' Last');
    expect(joinOverlappingChunks(['First part.', 'Second part.'])).toBe('First part.\n\nSecond part.');
  });
  it('strips identified chrome while retaining actual instructions', () => {
    const body = 'Steps\n1. Open settings.\n2. Save.\n| port |\n| eth0 |';
    const text = '# Manual\nDocuments Best Practices Cases Softwares Navigation Read Permission:Guest Download Share | Favorite Updated On: [REDACTED_PHONE] '+body+' This documentation helps me solve problems easily. If your issue is not resolved, you can ask Online Support for help. Footer';
    expect(stripSupportChrome(text)).toBe('# Manual\n\n'+body);
    expect(stripSupportChrome('# Ordinary\nRead Permission:Guest example')).toBe('# Ordinary\nRead Permission:Guest example');
  });
  it('retains complete tables and fenced commands even beyond the soft size budget', () => {
    const table = '| key | value |\n| --- | --- |\n'+'| mtu | 1500 |\n'.repeat(30);
    const code = '```sh\n'+'ip link show eth0\n'.repeat(30)+'```';
    const chunks = structuredChunks('# Network\n\n'+table+'\n'+code, 200);
    expect(chunks.some((chunk) => chunk.includes(table.trim()))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes(code))).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith('# Network'))).toBe(true);
  });
  it('retains ordered procedure content and terminates on unbroken long input', () => {
    const chunks = structuredChunks('# Steps\n\n1. Inspect.\n2. Configure.\n3. Verify.\n\n'+'x'.repeat(1000), 200);
    expect(chunks.join('\n')).toContain('1. Inspect.\n2. Configure.\n3. Verify.');
    expect(chunks.join('').match(/x/g)?.length).toBe(1000);
    expect(() => structuredChunks('text', 0)).toThrow('RAG_CHUNK_SIZE_INVALID');
  });
});
