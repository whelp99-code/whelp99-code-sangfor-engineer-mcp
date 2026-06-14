import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { loadOneSessionFromEnv, resolveAuthTokens, verifyOneSession } from '../packages/sangfor-collector/src/index.js';
import { exportRagIndexSummary, ragSearch } from '../packages/sangfor-rag/src/index.js';
import { validateFineTuneDataset } from '../packages/sangfor-finetune/src/index.js';

loadEnvFile('.env');

const config = loadOneSessionFromEnv();
const tokens = await resolveAuthTokens(config);
const oneOk = tokens.oneAccessToken
  ? await verifyOneSession(tokens.oneAccessToken, config.oneBaseUrl)
  : { ok: false };

const manifest = existsSync('data/sources/manifest.json')
  ? JSON.parse(readFileSync('data/sources/manifest.json', 'utf8'))
  : [];

const report = {
  completedAt: new Date().toISOString(),
  auth: { oneSessionValid: oneOk.ok, hasKbToken: Boolean(tokens.kbToken), sources: tokens.sources },
  manifestCount: Array.isArray(manifest) ? manifest.length : 0,
  finetune: validateFineTuneDataset('data/finetune/sangfor-sources.jsonl'),
  rag: exportRagIndexSummary('data/rag/index.json'),
  ragSmoke: (await ragSearch({ query: 'Sangfor HCI deployment precheck', product: 'HCI', limit: 5 })).map(h => ({
    id: h.id,
    title: h.title,
    score: h.score
  }))
};

writeFileSync('data/sources/learning-complete.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
