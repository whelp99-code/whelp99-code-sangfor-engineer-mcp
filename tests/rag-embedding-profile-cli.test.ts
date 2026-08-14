import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

describe('rag:profile CLI', () => {
  it('prints hash fallback profile without mutating index data', () => {
    const output = execFileSync('pnpm', ['tsx', 'scripts/rag-embedding-profile.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SANGFOR_EMBEDDING_FORCE_HASH: '1' }
    });
    const artifact = JSON.parse(output) as {
      backend: string;
      wasFallback: boolean;
      profile: { requiresRolePrefix: boolean };
    };

    expect(artifact.backend).toBe('hash');
    expect(artifact.wasFallback).toBe(true);
    expect(artifact.profile.requiresRolePrefix).toBe(false);
  });
});
