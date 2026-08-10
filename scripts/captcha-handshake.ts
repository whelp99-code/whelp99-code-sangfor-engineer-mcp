import { existsSync, readFileSync, rmSync } from 'node:fs';
import { ocrCaptcha } from '../packages/sangfor-chrome/src/index.js';

const CAPTCHA_PATTERN = /^[A-Za-z0-9]{4}$/u;

type OcrReader = (imagePath: string) => Promise<{ success: boolean; text?: string }>;

export interface CaptchaCodeResult {
  code: string;
  source: 'ocr' | 'manual';
}

export async function resolveCaptchaCode(options: {
  imagePath: string;
  codePath: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  readOcr?: OcrReader;
}): Promise<CaptchaCodeResult | null> {
  const {
    imagePath,
    codePath,
    timeoutMs = 180_000,
    pollIntervalMs = 2_000,
    readOcr = ocrCaptcha,
  } = options;

  rmSync(codePath, { force: true });

  try {
    const result = await readOcr(imagePath);
    const code = result.text?.trim() ?? '';
    if (result.success && CAPTCHA_PATTERN.test(code)) {
      return { code, source: 'ocr' };
    }
  } catch (error) {
    console.error(`[CAPTCHA] OCR unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(codePath)) {
      const code = readFileSync(codePath, 'utf8').trim();
      if (CAPTCHA_PATTERN.test(code)) return { code, source: 'manual' };
      rmSync(codePath, { force: true });
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}
