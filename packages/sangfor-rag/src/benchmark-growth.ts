import type { BenchmarkChunk } from './benchmark-schema.js';
import { canonicalJson, sha256 } from './benchmark-schema.js';

export type GrowthResult = {
  readonly chunks: readonly BenchmarkChunk[];
  readonly generatedDigest: string;
  readonly generatedCount: number;
};

export function growBenchmarkChunks(base: readonly BenchmarkChunk[], multiplier: number): GrowthResult {
  const generated: BenchmarkChunk[] = [];
  for (let copy = 1; copy < multiplier; copy += 1) {
    for (const chunk of base) {
      const suffix = String(copy).padStart(2, '0');
      generated.push({
        ...chunk,
        id: `growth-${suffix}-${chunk.id}`,
        title: `Synthetic scoped decoy ${suffix}`,
        text: `sanitized deterministic growth decoy ${suffix} for ${chunk.product.toLowerCase()}`,
        filePath: `synthetic/growth/${suffix}/${chunk.id}.md`
      });
    }
  }
  generated.sort((left, right) => left.id.localeCompare(right.id));
  const chunks = [...base, ...generated];
  return {
    chunks,
    generatedDigest: sha256(canonicalJson(generated)),
    generatedCount: generated.length
  };
}
