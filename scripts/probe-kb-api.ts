import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { loadOneSessionFromEnv, resolveAuthTokens } from '../packages/sangfor-collector/src/index.js';

loadEnvFile('.env');

const kb = 'https://knowledgebase.sangfor.com';
const paths = [
  '/api-kb/article/front/menuTreeList',
  '/api-kb/article/front/markDown',
  '/api-auth/kbOauth/partnerUser/kbTokenJump',
  '/api-kb/category/menuTree'
];

async function tryPost(path: string, token: string, body: Record<string, unknown>) {
  const url = `${kb}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      accept: 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return { path, status: res.status, len: text.length, preview: text.slice(0, 120) };
}

async function main() {
  const tokens = await resolveAuthTokens(loadOneSessionFromEnv());
  const token = tokens.kbToken ?? tokens.oneAccessToken;
  if (!token) {
    console.log('no token');
    process.exit(1);
  }
  const results = [];
  for (const path of paths) {
    results.push(await tryPost(path, token, path.includes('markDown')
      ? { articleId: 'test', articleType: 1 }
      : {}));
  }
  console.log(JSON.stringify(results, null, 2));
}

main();
