import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root=mkdtempSync(join(tmpdir(),'postgres-no-db-writers-'));
let getToolHandler:(name:string)=>((input:unknown)=>unknown)|undefined;
beforeAll(async()=>{process.env.MCP_NO_SERVE='1';process.env.SANGFOR_BLRO_AUTHORITY_STORE='postgres';delete process.env.DATABASE_URL;delete process.env.SANGFOR_BLRO_DATABASE_URL;process.env.SANGFOR_EVALS_ROOT=join(root,'evals');process.env.SANGFOR_FEEDBACK_ROOT=join(root,'feedback');process.env.SANGFOR_WIKI_ROOT=join(root,'wiki');({getToolHandler}=await import('../apps/mcp-server/src/index.js'));});
afterAll(()=>rmSync(root,{recursive:true,force:true}));

describe('postgres selector without authority runtime',()=>{
  it('refuses eval, feedback, and wiki writers before creating bytes',async()=>{
    const calls=[
      ['sangfor_create_eval_case_from_feedback',{product:'HCI',name:'n',requiredText:'x'}],
      ['sangfor_submit_feedback',{product:'HCI',feedbackType:'quality',severity:'medium',feedbackText:'x',sourceRole:'engineer'}],
      ['sangfor_propose_wiki_update',{lessonTitle:'t',lessonBody:'b'}],
    ] as const;
    for(const [name,input] of calls)await expect(Promise.resolve().then(()=>getToolHandler(name)?.(input))).rejects.toThrow('POSTGRES_AUTHORITY_FENCE_REQUIRED');
    expect(readdirSync(root)).toEqual([]);
  });
});
