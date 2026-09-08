import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApi } from '../apps/control-tower/src/api.js';

describe('control tower production fence composition', () => {
  it('refuses postgres selection before constructing any local writer and leaves bytes unchanged', () => {
    const root=mkdtempSync(join(tmpdir(),'tower-postgres-fence-'));const registry=join(root,'registry');const runs=join(root,'runs');
    const sentinel=join(root,'sentinel');writeFileSync(sentinel,'unchanged');
    try {
      expect(()=>createApi({authorityMode:'postgres',registryDir:registry,runsDir:runs})).toThrow('POSTGRES_AUTHORITY_FENCE_REQUIRED');
      expect(readFileSync(sentinel,'utf8')).toBe('unchanged');
    } finally { rmSync(root,{recursive:true,force:true}); }
  });
});
