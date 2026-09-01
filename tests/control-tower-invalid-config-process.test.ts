import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('control-tower malformed authority config process shell', () => {
  it('refuses startup before listen and redacts malformed database credentials', async () => {
    const malformedUrl='postgresql://operator:must-not-leak@%';
    const inherited=Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='MCP_NO_SERVE'&&key!=='VITEST'));
    const child=spawn(process.execPath,['--import','tsx','apps/control-tower/src/server.ts'],{cwd:process.cwd(),env:{...inherited,PORT:'0',BIND_HOST:'127.0.0.1',SANGFOR_API_TOKEN:'test-token',SANGFOR_TOWER_SEED_PLAYBOOKS:'0',SANGFOR_BLRO_AUTHORITY_STORE:'postgres',DATABASE_URL:malformedUrl,SANGFOR_TENANT_ID:'tenant-a',SANGFOR_PROJECT_ID:'project-a',SANGFOR_ACTOR_ID:'actor-a',SANGFOR_BLRO_SIGNING_PRIVATE_KEY_PATH:'/missing/signing.key',SANGFOR_BLRO_TRUST_BUNDLE_PATH:'/missing/ca.crt',SANGFOR_BLRO_AUDIT_SECRET:'a'.repeat(32),SANGFOR_OPERATOR_APPROVAL_SECRET:'o'.repeat(32)},stdio:['ignore','pipe','pipe']});
    let stdout='';let stderr='';child.stdout?.on('data',(chunk:Buffer)=>{stdout+=chunk.toString();});child.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
    const [code]=await once(child,'close',{signal:AbortSignal.timeout(5_000)});
    expect(code).not.toBe(0);expect(stdout).not.toContain('listening');expect(stderr).not.toContain(malformedUrl);
  });
});
