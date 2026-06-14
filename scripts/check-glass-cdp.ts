/**
 * Health check for Glass/Chrome CDP before learn:kb:full automation.
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.SANGFOR_CDP_URL ?? 'http://127.0.0.1:9222';

async function main() {
  let version: unknown;
  try {
    const res = await fetch(`${CDP_URL}/json/version`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    version = await res.json();
  } catch (err) {
    console.log(JSON.stringify({
      ok: false,
      cdpUrl: CDP_URL,
      error: String(err),
      hint: 'Open Cursor Glass browser with KB logged in; ensure CDP port 9222 is exposed.'
    }, null, 2));
    process.exit(2);
  }

  const browser = await chromium.connectOverCDP(CDP_URL);
  const tabs = browser.contexts().flatMap(c =>
    c.pages().map(p => ({ url: p.url(), title: '' }))
  );
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      const idx = tabs.findIndex(t => t.url === page.url());
      if (idx >= 0) tabs[idx].title = await page.title().catch(() => '');
    }
  }
  await browser.close();

  const kbTab = tabs.find(t => /knowledgebase\.sangfor\.com/i.test(t.url));
  console.log(JSON.stringify({
    ok: true,
    cdpUrl: CDP_URL,
    browser: version,
    tabCount: tabs.length,
    kbTabFound: Boolean(kbTab),
    kbTabUrl: kbTab?.url,
    tabs: tabs.slice(0, 12)
  }, null, 2));
  process.exit(kbTab ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
