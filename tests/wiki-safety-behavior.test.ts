import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyWikiUpdate,
  applyWikiUpdateWithAdapter,
  approveWikiUpdate,
  listKnowledgeCards,
  listSeedWiki,
  mintWikiApproval,
  proposeWikiUpdate,
  searchWiki,
  upsertKnowledgeCard,
  type KnowledgeCard,
  type WikiAdapter,
  type WikiUpdateProposal,
} from '../packages/sangfor-wiki/src/index.js';
import { testLocalWriteAuthority } from './helpers/local-write-authority.js';

const SECRET_MISSING = new Error('Wiki approval blocked: SANGFOR_WIKI_APPROVAL_SECRET is not configured (fail-closed).');
const TOKEN_INVALID = new Error('Wiki approval token is not a valid HMAC for this proposal.');
const APPROVAL_REQUIRED = new Error('Wiki update is blocked until approval is granted.');
const CITATION_REQUIRED = new Error('KnowledgeCard requires at least one source citation.');

const savedEnvironment = { ...process.env };
let wikiRoot: string;

function authority() {
  return testLocalWriteAuthority('wiki_proposals');
}

async function propose(title = 'Lesson'): Promise<WikiUpdateProposal> {
  return proposeWikiUpdate({ lessonTitle: title, lessonBody: 'Body' }, authority());
}

function proposalRecords(): readonly WikiUpdateProposal[] {
  return readFileSync(join(wikiRoot, 'proposals.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as WikiUpdateProposal);
}

const recordingAdapter = () => {
  const writes: string[] = [];
  const adapter: WikiAdapter = {
    readPage: async () => 'existing body',
    writePage: async (path, content, message) => {
      writes.push(content);
      return { ok: true, path, message };
    },
  };
  return { adapter, writes };
};

beforeEach(() => {
  wikiRoot = mkdtempSync(join(tmpdir(), 'wiki-safety-'));
  process.env.SANGFOR_WIKI_ROOT = wikiRoot;
  delete process.env.SANGFOR_WIKI_APPROVAL_SECRET;
});

afterEach(() => {
  process.env = { ...savedEnvironment };
  rmSync(wikiRoot, { recursive: true, force: true });
});

describe('wiki approval refusals', () => {
  it('refuses to mint an approval token when no secret is configured', () => {
    // Given no approval secret in the environment.
    // When a token is minted.
    // Then the fail-closed message is raised verbatim.
    expect(() => mintWikiApproval('wiki_proposal_1')).toThrow(SECRET_MISSING);
  });

  it('refuses an approval whose token is bound to a different proposal', async () => {
    // Given two proposals and a token minted for the first.
    process.env.SANGFOR_WIKI_APPROVAL_SECRET = 'secret';
    const first = await propose('First');
    const second = await propose('Second');

    // When the first proposal's token is presented for the second.
    const approval = approveWikiUpdate(second.id, 'approved', { token: mintWikiApproval(first.id) }, authority());

    // Then the action-binding failure is raised and the record stays pending.
    await expect(approval).rejects.toThrow(TOKEN_INVALID);
    expect(proposalRecords().at(-1)?.status).toBe('pending');
  });

  it('refuses an approval token that is shorter than the expected digest', async () => {
    // Given a proposal and a truncated token.
    process.env.SANGFOR_WIKI_APPROVAL_SECRET = 'secret';
    const proposal = await propose();

    // When the truncated token is presented.
    const approval = approveWikiUpdate(proposal.id, 'approved', { token: 'deadbeef' }, authority());

    // Then length comparison refuses it before any timing-safe compare.
    await expect(approval).rejects.toThrow(TOKEN_INVALID);
  });

  it('refuses a decision on an unknown proposal id', async () => {
    // Given an id that was never proposed.
    // When a rejection is attempted.
    const approval = approveWikiUpdate('wiki_proposal_absent', 'rejected', {}, authority());

    // Then the unknown-proposal message names the id.
    await expect(approval).rejects.toThrow(new Error('Unknown proposal: wiki_proposal_absent'));
  });

  it('rotates the approval secret out from under a previously minted token', async () => {
    // Given a token minted under the first secret.
    process.env.SANGFOR_WIKI_APPROVAL_SECRET = 'first-secret';
    const proposal = await propose();
    const staleToken = mintWikiApproval(proposal.id);

    // When the secret is rotated before the token is redeemed.
    process.env.SANGFOR_WIKI_APPROVAL_SECRET = 'second-secret';
    const approval = approveWikiUpdate(proposal.id, 'approved', { token: staleToken }, authority());

    // Then the stale token no longer authorizes the approval.
    await expect(approval).rejects.toThrow(TOKEN_INVALID);
  });
});

describe('wiki apply gating', () => {
  it('refuses to apply a pending proposal through the plain path', async () => {
    // Given a pending proposal.
    const proposal = await propose();

    // When it is applied without approval.
    // Then the approval gate refuses it.
    await expect(applyWikiUpdate(proposal.id, authority())).rejects.toThrow(APPROVAL_REQUIRED);
  });

  it('refuses to apply a rejected proposal through an adapter and never touches the page', async () => {
    // Given a rejected proposal and a recording adapter.
    const proposal = await propose();
    await approveWikiUpdate(proposal.id, 'rejected', {}, authority());
    const { adapter, writes } = recordingAdapter();

    // When the adapter apply path runs.
    const applied = applyWikiUpdateWithAdapter(proposal.id, adapter, authority());

    // Then it refuses and the adapter received no write.
    await expect(applied).rejects.toThrow(APPROVAL_REQUIRED);
    expect(writes).toEqual([]);
  });

  it('applies an approved proposal by appending to the existing page body', async () => {
    // Given an approved proposal and a page that already has content.
    process.env.SANGFOR_WIKI_APPROVAL_SECRET = 'secret';
    const proposal = await propose('Storage MTU');
    await approveWikiUpdate(proposal.id, 'approved', { token: mintWikiApproval(proposal.id) }, authority());
    const { adapter, writes } = recordingAdapter();

    // When the adapter apply path runs.
    const result = await applyWikiUpdateWithAdapter(proposal.id, adapter, authority());

    // Then the prior body is preserved ahead of the proposed text and status advances.
    expect(result.status).toBe('applied');
    expect(result.beforeText).toBe('existing body');
    expect(writes).toEqual(['existing body\n\n## Storage MTU\n\nBody\n']);
  });
});

describe('wiki proposal ledger', () => {
  it('appends one record per transition and resolves a proposal to its latest status', async () => {
    // Given a proposal that is approved and then applied.
    process.env.SANGFOR_WIKI_APPROVAL_SECRET = 'secret';
    const proposal = await propose();
    await approveWikiUpdate(proposal.id, 'approved', { token: mintWikiApproval(proposal.id), reviewer: 'cm@corp' }, authority());
    await applyWikiUpdate(proposal.id, authority());

    // When the append-only ledger is read back.
    const records = proposalRecords();

    // Then every transition is retained in order and the last one wins.
    expect(records.map((record) => record.status)).toEqual(['pending', 'approved', 'applied']);
    expect(records.every((record) => record.id === proposal.id)).toBe(true);
    expect(records.at(-1)?.reviewer).toBe('cm@corp');
  });

  it('keeps proposals of separate ids independent in the shared ledger', async () => {
    // Given two proposals in one ledger where only the second is rejected.
    const first = await propose('First');
    const second = await propose('Second');

    // When the second is rejected.
    await approveWikiUpdate(second.id, 'rejected', {}, authority());

    // Then the first proposal is untouched.
    const latest = new Map(proposalRecords().map((record) => [record.id, record.status]));
    expect(latest.get(first.id)).toBe('pending');
    expect(latest.get(second.id)).toBe('rejected');
  });
});

describe('wiki knowledge and seed corpus', () => {
  it('refuses a knowledge card that carries no citation', async () => {
    // Given a card with an empty citation list.
    const card: Omit<KnowledgeCard, 'id' | 'updatedAt'> = {
      type: 'procedure',
      product: 'HCI',
      title: 'Uncited',
      prerequisites: [],
      steps: [],
      warnings: [],
      verification: [],
      rollback: [],
      citations: [],
      trustLevel: 'internal',
    };

    // When it is upserted.
    // Then the citation requirement refuses it and nothing is stored.
    await expect(upsertKnowledgeCard(card, authority())).rejects.toThrow(CITATION_REQUIRED);
    expect(listKnowledgeCards()).toEqual([]);
  });

  it('scopes search to the requested product and ranks by query term hits', async () => {
    // Given the seed corpus spanning several products.
    // When HCI is searched for a term that only one seed lesson carries.
    const hits = searchWiki({ product: 'HCI', query: 'MTU consistency', limit: 3 });

    // Then every hit is HCI and the MTU lesson ranks first.
    expect(hits.map((hit) => hit.product)).toEqual(['HCI', 'HCI', 'HCI']);
    expect(hits[0]?.id).toBe('wiki_hci_mtu_lesson_001');
  });

  it('hands out a seed corpus copy that callers cannot mutate in place', () => {
    // Given the seed corpus.
    const first = listSeedWiki();

    // When a caller truncates the array it received.
    first.length = 0;

    // Then the next caller still gets the full corpus.
    expect(listSeedWiki()).toHaveLength(9);
  });
});
