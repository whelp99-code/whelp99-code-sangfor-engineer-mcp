import { runRemoteShadowCli } from '../packages/sangfor-observer/src/remote-shadow-cli.js';

process.exitCode = await runRemoteShadowCli(process.argv.slice(2));
