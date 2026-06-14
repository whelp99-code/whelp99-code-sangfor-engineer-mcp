import { resolve, dirname, join } from 'node:path';
import { buildSettingGuideDocx } from '../packages/sangfor-product-adapters/src/docx-builder.js';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const EXCEL_PATH = process.env.ITAC_EXCEL_PATH ?? '/Users/jmpark/Documents/개인자료/법인 - 베를로/1. Project/202601 - 일지테크 - Total infra/## ITAC Results Updated_현대차 감사_sangfor.xlsx';
const DOCX_PATH = join(ROOT, 'outputs/customer-setting-guide/sangfor-customer-setting-guide.docx');

const result = buildSettingGuideDocx({ filePath: EXCEL_PATH, outputPath: DOCX_PATH });
console.log(`Generated: ${result.docxPath}`);
console.log(`Size: ${result.size} bytes`);
console.log(`Sections: ${result.sections.join(', ')}`);
console.log(`Plan: ${result.planId} (${result.totalItems} items, ${result.consoleItems} console, ${result.manualItems} manual)`);
