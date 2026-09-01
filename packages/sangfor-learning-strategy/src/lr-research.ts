/**
 * PR-009: LR-01~LR-04 research, benchmark, and stale-candidate workflows.
 *
 * This compatibility facade preserves the original public import path while
 * each workflow remains owned by one focused module.
 */
export * from './lr01-research.js';
export * from './lr02-benchmark.js';
export * from './lr03-probe.js';
export * from './lr04-benchmark.js';
export * from './stale-candidate.js';
