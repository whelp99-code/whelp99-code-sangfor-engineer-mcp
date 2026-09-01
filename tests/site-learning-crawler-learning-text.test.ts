import { describe, expect, it } from 'vitest';
import {
  isDocumentFineTuneEligible,
  isFineTuneEligibleLearningText,
  normalizeLearningText,
  prepareLearningTextForFineTune,
  redactLearningSensitiveData
} from '../packages/sangfor-collector/src/site-learning-crawler.js';

describe('two-site learning crawler learned-text safety filters', () => {
  it('deduplicates repeated rendered text and masks contact or token-like data', () => {
    expect(normalizeLearningText('Header\nHeader\n\nUseful body\nUseful body')).toBe(
      'Header\n\nUseful body'
    );
    expect(redactLearningSensitiveData(
      'Contact admin@example.com or +60 12 711 7511. Authorization: Bearer abcdefghijklmnopqrstuvwxyz'
    )).toBe('Contact [REDACTED_EMAIL] or [REDACTED_PHONE]. Authorization: Bearer [REDACTED_TOKEN]');
  });

  it('keeps full text in RAG but excludes sensitive-topic pages from fine-tuning', () => {
    expect(isFineTuneEligibleLearningText('Configure the cluster MTU and validate connectivity.')).toBe(true);
    expect(isFineTuneEligibleLearningText('Reset the administrator password and copy the secret.')).toBe(false);
    expect(isFineTuneEligibleLearningText('Privacy Policy for account information')).toBe(false);
  });

  it('matches the fine-tune validator exactly: plural topics are sensitive, innocent substrings are not', () => {
    // The producer filter and validateFineTuneDataset must agree, or a fully collected
    // corpus dies at the last validation step. Plurals used to pass the producer and
    // then trip the validator; "footprint" (which contains "otp") used to be flagged as
    // sensitive by the validator even though no topic word is present.
    expect(isFineTuneEligibleLearningText('Reset the administrator passwords for each node.')).toBe(false);
    expect(isFineTuneEligibleLearningText('Import the license keys before adding a node.')).toBe(false);
    expect(isFineTuneEligibleLearningText('Store any secrets outside the repository.')).toBe(false);
    expect(isFineTuneEligibleLearningText('Reduced data center footprint and lower power draw.')).toBe(true);
  });

  it('keeps safe technical paragraphs for fine-tuning while dropping sensitive paragraphs', () => {
    expect(prepareLearningTextForFineTune([
      'Configure the cluster MTU and validate connectivity before deployment.',
      'Reset the administrator password and copy the secret token.',
      'Verify node health and record the read-back result after the change.'
    ].join('\n\n'))).toBe([
      'Configure the cluster MTU and validate connectivity before deployment.',
      'Verify node health and record the read-back result after the change.'
    ].join('\n\n'));
  });

  it('rejects a document from fine-tuning when its TITLE alone carries a sensitive topic, even if the body is clean', () => {
    // A document body can pass prepareLearningTextForFineTune while its raw title
    // (used verbatim as the fine-tune "input" prompt) still leaks a sensitive topic
    // word (e.g. "Reset Admin Password", "License Key Activation") — the eligibility
    // check must cover the title too, not just the body paragraphs.
    const longSafeBody = 'Configure the cluster MTU and validate connectivity before deployment. '
      + 'Confirm every node reports the same MTU value and that jumbo frames are enabled end to end. '
      + 'Re-run the network validation tool after applying the change to confirm the cluster is healthy.';
    expect(isDocumentFineTuneEligible('How to Reset the Admin Password', longSafeBody)).toBe(false);
    expect(isDocumentFineTuneEligible('HCI Cluster MTU Configuration', longSafeBody)).toBe(true);
    expect(isDocumentFineTuneEligible('HCI Cluster MTU Configuration', 'too short')).toBe(false);
  });
});
