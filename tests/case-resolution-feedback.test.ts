import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { WikiUpdateProposal } from '../packages/sangfor-wiki/src/index.js';

const proposeWikiUpdateMock = vi.fn(
  (input: { lessonTitle: string; lessonBody: string; targetPage?: string }): WikiUpdateProposal => ({
    id: 'wiki_proposal_test_001',
    targetPage: input.targetPage ?? 'Sangfor/Lessons/Pending.md',
    title: input.lessonTitle,
    beforeText: '<current page content not loaded in proposal stage>',
    afterText: `## ${input.lessonTitle}\n\n${input.lessonBody}\n`,
    status: 'pending',
    adapter: 'memory'
  })
);
const applyWikiUpdateWithAdapterMock = vi.fn();
const approveWikiUpdateMock = vi.fn();

vi.mock('../packages/sangfor-wiki/src/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/sangfor-wiki/src/index.js')>();
  return {
    ...actual,
    proposeWikiUpdate: proposeWikiUpdateMock,
    applyWikiUpdateWithAdapter: applyWikiUpdateWithAdapterMock,
    approveWikiUpdate: approveWikiUpdateMock
  };
});

const { postCaseResolution } = await import('../apps/operator-console/src/case-resolution.js');
const { createOperatorServer } = await import('../apps/operator-console/src/server.js');

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createOperatorServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(() => {
  proposeWikiUpdateMock.mockClear();
  applyWikiUpdateWithAdapterMock.mockClear();
  approveWikiUpdateMock.mockClear();
});

describe('postCaseResolution', () => {
  it('creates a pending wiki proposal and never applies or approves it', async () => {
    const result = await postCaseResolution({
      product: 'HCI',
      caseSummary: 'HCI storage heartbeat flapping after node join',
      resolution: 'Ran MTU consistency check on the storage network before rejoining nodes.',
      targetWikiPage: 'Sangfor/Lessons/HCI.md'
    });

    expect(proposeWikiUpdateMock).toHaveBeenCalledWith({
      lessonTitle: 'HCI storage heartbeat flapping after node join',
      lessonBody: 'Ran MTU consistency check on the storage network before rejoining nodes.',
      targetPage: 'Sangfor/Lessons/HCI.md'
    });
    expect(applyWikiUpdateWithAdapterMock).not.toHaveBeenCalled();
    expect(approveWikiUpdateMock).not.toHaveBeenCalled();
    expect(result).toEqual({ feedbackId: null, proposalId: 'wiki_proposal_test_001' });
  });

  it('defaults sourceRole to engineer when not provided', async () => {
    await postCaseResolution({
      product: 'IAG',
      caseSummary: 'Policy bypass missing',
      resolution: 'Added emergency bypass policy before restrictive rules.',
      targetWikiPage: 'Sangfor/Lessons/IAG.md'
    });
    expect(applyWikiUpdateWithAdapterMock).not.toHaveBeenCalled();
    expect(approveWikiUpdateMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/case-resolution', () => {
  it('registers the route, proposes a wiki update, and never applies or approves it', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/case-resolution`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          product: 'IAG',
          caseSummary: 'Policy bypass missing',
          resolution: 'Added emergency bypass policy before restrictive rules.',
          targetWikiPage: 'Sangfor/Lessons/IAG.md'
        })
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.proposalId).toBeTruthy();
      expect(proposeWikiUpdateMock).toHaveBeenCalled();
      expect(applyWikiUpdateWithAdapterMock).not.toHaveBeenCalled();
      expect(approveWikiUpdateMock).not.toHaveBeenCalled();
    });
  });

  it('returns 400 and proposes nothing when required fields are missing', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/case-resolution`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ product: 'IAG' })
      });
      expect(res.status).toBe(400);
      expect(proposeWikiUpdateMock).not.toHaveBeenCalled();
    });
  });
});
