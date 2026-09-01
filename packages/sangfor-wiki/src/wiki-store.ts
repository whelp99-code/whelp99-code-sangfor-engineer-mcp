import { join } from 'node:path';
import { foldJsonlById, resolveRepoData } from '@sangfor/shared';
import { knowledgeCardCodec, wikiProposalCodec } from './runtime-codecs.js';
import type { KnowledgeCard } from './wiki-types.js';

export const wikiRoot = () => resolveRepoData('data/wiki', 'SANGFOR_WIKI_ROOT');
export const proposalsFile = () => join(wikiRoot(), 'proposals.jsonl');
export const cardsFile = () => join(wikiRoot(), 'knowledge-cards.jsonl');
export const getProposal = (id: string) => foldJsonlById(proposalsFile(), wikiProposalCodec).get(id);

export function listKnowledgeCards(): KnowledgeCard[] {
  return [...foldJsonlById(cardsFile(), knowledgeCardCodec).values()];
}
