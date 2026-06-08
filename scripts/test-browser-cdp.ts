/**
 * Integration test: Start a live operator session with Chrome CDP
 * and read live console state.
 */
import { startOperatorSession, readLiveConsoleState, readConsoleState } from '../packages/sangfor-operator/src/index.js';

async function main() {
  console.log('=== Browser CDP Integration Test ===\n');

  // Step 1: Start session with Chrome CDP
  console.log('1. Starting operator session with browser CDP...');
  const session = startOperatorSession({
    product: 'ENDPOINT_SECURE',
    mode: 'customer_readonly',
    targetUrl: 'http://localhost:3400/endpoint-secure',
    browser: {
      cdpPort: 9333,
      startIfMissing: true,
    },
  });
  console.log(`   Session created: ${session.id}`);
  console.log(`   Product: ${session.product}`);
  console.log(`   Mode: ${session.mode}`);
  console.log(`   CDP Port: ${session.cdpPort}`);

  // Step 2: Try reading live console state (will attempt Chrome CDP connection)
  console.log('\n2. Attempting live console state read (Playwright CDP connection)...');
  try {
    const liveState = await readLiveConsoleState({ sessionId: session.id });
    console.log(`   Browser type: ${liveState.browser}`);
    console.log(`   Connected over CDP: ${liveState.connectedOverCdp ?? 'N/A'}`);
    console.log(`   Page title: ${liveState.title}`);
    console.log(`   Page URL: ${liveState.url}`);
    console.log(`   Screenshot: ${liveState.screenshotPath}`);
    console.log('\n   ✅ Chrome CDP connection successful!');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`   ⚠️  Live read error: ${msg}`);
    // Fall back to mock state
    console.log('\n3. Falling back to mock console state...');
    const mockState = readConsoleState(session.id);
    console.log(`   Screen: ${mockState.screen}`);
    console.log(`   Available elements: ${Array.isArray(mockState.availableElements) ? mockState.availableElements.length : 0} items`);
    console.log('\n   ⚠️  Live CDP connection not available (Chrome may need manual start)');
  }

  console.log('\n=== Test Complete ===');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
