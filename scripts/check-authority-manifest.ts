import { AUTHORITY_MANIFEST, validateAuthorityManifest } from '../packages/sangfor-authority/src/migration-manifest.js';
import { censusRepository } from '../packages/sangfor-authority/src/repository-census.js';

const json = process.argv.slice(2).includes('--json');
const inventory = censusRepository(process.cwd());
const result = validateAuthorityManifest(AUTHORITY_MANIFEST, inventory);

if (!result.ok) {
  const output = { status: 'AUTHORITY_MANIFEST_REFUSED', issues: result.issues };
  process.stderr.write(`${json ? JSON.stringify(output) : `${output.status}\n${output.issues.join('\n')}`}\n`);
  process.exitCode = 1;
} else {
  const output = {
    status: 'AUTHORITY_MANIFEST_PASS',
    aggregateCount: result.aggregateCount,
    classes: result.classes,
    inventory: result.inventory,
    inventoryDigest: result.digest,
    aggregates: AUTHORITY_MANIFEST.entries.map((entry) => entry.aggregate),
  };
  process.stdout.write(`${json ? JSON.stringify(output) : `${output.status}: ${output.aggregateCount} aggregates`}\n`);
}
