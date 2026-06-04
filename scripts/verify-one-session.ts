import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { loadOneSessionFromEnv, resolveAuthTokens, verifyOneSession } from '../packages/sangfor-collector/src/index.js';

loadEnvFile('.env');

async function main() {
  const config = loadOneSessionFromEnv();
  if (!config.accessToken && !config.oauthCode && !config.kbToken) {
    console.error('Set SANGFOR_ONE_ACCESS_TOKEN or SANGFOR_OAUTH_CODE or SANGFOR_KB_TOKEN in .env');
    process.exit(1);
  }

  const tokens = await resolveAuthTokens(config);
  const oneOk = tokens.oneAccessToken
    ? await verifyOneSession(tokens.oneAccessToken, config.oneBaseUrl)
    : { ok: false };

  console.log(JSON.stringify({
    tokenSources: tokens.sources,
    oneSessionValid: oneOk.ok,
    hasOneAccessToken: Boolean(tokens.oneAccessToken),
    hasKbToken: Boolean(tokens.kbToken),
    oneBaseUrl: config.oneBaseUrl,
    kbBaseUrl: config.kbBaseUrl
  }, null, 2));

  if (!oneOk.ok && !tokens.kbToken) process.exit(2);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
