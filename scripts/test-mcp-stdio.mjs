#!/usr/bin/env node
import { spawn } from 'child_process';
import { readFileSync } from 'fs';

const SERVER_PATH = new URL('index.ts', import.meta.url);

// Read .env file content
const envContent = readFileSync(new URL('../../../.env', import.meta.url), 'utf-8');
console.log('[Env loaded]', envContent.substring(0, 100));

// Start server
const server = spawn('npx', ['tsx', SERVER_PATH], {
  stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
  cwd: new URL('../../', import.meta.url).pathname
});

server.stdout.on('data', (data) => {
  console.log(`SERVER: ${data.toString().trim().substring(0, 200)}`);
});

server.stderr.on('data', (data) => {
  console.error(`SERVER_ERR: ${data.toString().trim().substring(0, 200)}`);
});

// Send initialize request
const initReq = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  }
});

console.log('>>>', initReq);
server.stdin.write(initReq + '\n');

// Wait for response
setTimeout(() => {
  server.stdin.end();
  
  // Send tools/list request
  const listReq = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list'
  });
  server.stdin.write(listReq + '\n');
  
  setTimeout(() => {
    server.kill('SIGTERM');
    console.log('Test completed');
  }, 2000);
}, 3000);

server.on('error', (err) => {
  console.error('Server error:', err.message);
  server.kill('SIGTERM');
  process.exit(1);
});

server.on('close', (code) => {
  console.log(`Server closed with code: ${code}`);
});
