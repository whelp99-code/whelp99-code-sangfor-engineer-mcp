import { describe, expect, it } from 'vitest';
import { resolveKbPersistentLaunchOptions } from '../scripts/lib/kb-browser-session.js';

describe('resolveKbPersistentLaunchOptions', () => {
  it('uses an explicit Chromium executable when configured', () => {
    expect(resolveKbPersistentLaunchOptions({
      SANGFOR_CHROMIUM_PATH: '/opt/chromium'
    })).toEqual({ executablePath: '/opt/chromium' });
  });

  it('uses the system Chrome channel by default', () => {
    expect(resolveKbPersistentLaunchOptions({})).toEqual({ channel: 'chrome' });
  });
});
