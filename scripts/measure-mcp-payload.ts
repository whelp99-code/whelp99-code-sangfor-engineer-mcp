/**
 * scripts/measure-mcp-payload.ts — W1 "MCP 응답 계약 정리" payload measurement.
 *
 * Runs representative calls through the MCP tool HANDLERS directly (no
 * subprocess, no device, no network — local repo data + hash embeddings only)
 * and prints the serialized byte size under the OLD contract (pretty-printed
 * JSON.stringify(x, null, 2), vectors included where the tool produces them)
 * vs the NEW contract (compact JSON.stringify(x), vectors omitted by default).
 *
 * Not registered in package.json scripts — run directly:
 *   npx tsx scripts/measure-mcp-payload.ts
 */
process.env.MCP_NO_SERVE = '1';
// Force the local hash embedding backend so this stays network-free and fast —
// the default (rapid-mlx) would try a real local model load before falling back.
process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function report(label: string, note: string, before: unknown, after: unknown): void {
  const beforeText = JSON.stringify(before, null, 2);
  const afterText = JSON.stringify(after);
  const beforeBytes = bytes(beforeText);
  const afterBytes = bytes(afterText);
  const pct = beforeBytes === 0 ? 0 : Math.round((1 - afterBytes / beforeBytes) * 1000) / 10;
  console.log(`\n${label}`);
  console.log(`  ${note}`);
  console.log(`  before (pretty-printed): ${beforeBytes.toLocaleString()} bytes`);
  console.log(`  after  (compact):        ${afterBytes.toLocaleString()} bytes`);
  console.log(`  reduction: ${pct}%`);
}

async function main() {
  const { getToolHandler } = await import('../apps/mcp-server/src/index.js');
  const { ragSearch, omitVectorFromHit } = await import('../packages/sangfor-rag/src/index.js');

  console.log('=== W1 MCP payload measurement (local handlers, no network) ===');

  // ── sangfor_rag_search(limit 8) — the vector-heavy tool C3 targets ─────────
  // Uses the repo's real local RAG index (data/rag/index.json) with hash
  // embeddings, exactly like a fresh checkout with no cloud embedding provider
  // configured would.
  const rawHits = await ragSearch({ query: 'HCI storage network MTU validation', limit: 8 });
  const strippedHits = rawHits.map(omitVectorFromHit);
  report(
    'sangfor_rag_search (limit 8)',
    `${rawHits.length} hits; old contract carried a ${rawHits[0]?.vector?.length ?? 0}-float vector per hit, new contract omits it by default (include_vectors:true opts back in)`,
    rawHits,
    strippedHits,
  );

  // ── sangfor_pm_events — seed a small in-memory engagement to have something to read ──
  const createEngagement = getToolHandler('sangfor_pm_create_engagement')!;
  const addWorkItem = getToolHandler('sangfor_pm_add_work_item')!;
  const pmEvents = getToolHandler('sangfor_pm_events')!;
  const engagement = (await createEngagement({ customer: 'Payload Measurement Co', product: 'HCI' })) as { id: string };
  for (let i = 0; i < 8; i++) await addWorkItem({ engagementId: engagement.id, title: `representative work item ${i}` });
  const eventsResult = await pmEvents({ engagementId: engagement.id });
  report(
    'sangfor_pm_events (no cursor/limit — default full timeline)',
    'no vector fields here — delta below is purely pretty-print vs compact JSON.stringify',
    eventsResult,
    eventsResult,
  );

  // ── sangfor_field_engineer_coverage — atoms array + coverage rollup ─────────
  const fieldEngineerCoverage = getToolHandler('sangfor_field_engineer_coverage')!;
  const coverageResult = await fieldEngineerCoverage({});
  report(
    'sangfor_field_engineer_coverage (no cursor/limit — default full atoms list)',
    'no vector fields here — delta below is purely pretty-print vs compact JSON.stringify',
    coverageResult,
    coverageResult,
  );

  console.log('\n=== done ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
