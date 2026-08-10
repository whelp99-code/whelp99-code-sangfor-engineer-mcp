import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCaptchaCode } from '../scripts/captcha-handshake.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveCaptchaCode', () => {
  it('uses OCR first and removes a stale manual code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'captcha-handshake-'));
    roots.push(root);
    const imagePath = join(root, 'EPP.png');
    const codePath = join(root, 'EPP.code');
    writeFileSync(imagePath, 'image');
    writeFileSync(codePath, 'STALE');

    const result = await resolveCaptchaCode({
      imagePath,
      codePath,
      readOcr: async () => ({ success: true, text: 'A7bC' }),
    });

    expect(result).toEqual({ code: 'A7bC', source: 'ocr' });
    expect(existsSync(codePath)).toBe(false);
  });

  it('falls back to a valid manual code after OCR fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'captcha-handshake-'));
    roots.push(root);
    const imagePath = join(root, 'CC.png');
    const codePath = join(root, 'CC.code');
    writeFileSync(imagePath, 'image');

    const resultPromise = resolveCaptchaCode({
      imagePath,
      codePath,
      timeoutMs: 100,
      pollIntervalMs: 1,
      readOcr: async () => ({ success: false }),
    });
    setTimeout(() => writeFileSync(codePath, 'Q2x9'), 5);

    await expect(resultPromise).resolves.toEqual({ code: 'Q2x9', source: 'manual' });
    expect(readFileSync(codePath, 'utf8')).toBe('Q2x9');
  });

  it('rejects malformed OCR and manual values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'captcha-handshake-'));
    roots.push(root);
    const imagePath = join(root, 'IAG.png');
    const codePath = join(root, 'IAG.code');
    writeFileSync(imagePath, 'image');
    writeFileSync(codePath, 'bad-value');

    await expect(resolveCaptchaCode({
      imagePath,
      codePath,
      timeoutMs: 5,
      pollIntervalMs: 1,
      readOcr: async () => ({ success: true, text: 'too-long' }),
    })).resolves.toBeNull();
    expect(existsSync(codePath)).toBe(false);
  });
});
