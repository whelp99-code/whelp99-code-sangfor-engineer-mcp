import { buildSettingGuidePptx } from '../packages/sangfor-pptx/src/index.js';
import { buildSettingGuideDocx } from '../packages/sangfor-product-adapters/src/docx-builder.js';

const EXCEL = '/Users/jmpark/Documents/개인자료/법인 - 베를로/1. Project/202601 - 일지테크 - Total infra/## ITAC Results Updated_현대차 감사_sangfor.xlsx';
const OUT = '/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp/outputs';
const SCREENSHOTS = '/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp/outputs/final_images';

async function main() {
  // PPTX
  const pptx = await buildSettingGuidePptx({
    filePath: EXCEL,
    outputPath: `${OUT}/Sangfor_설정가이드_v6_감사항목개별표시.pptx`,
    screenshotDir: SCREENSHOTS,
  });
  console.log('PPTX:', JSON.stringify(pptx, null, 2));

  // DOCX
  const docx = buildSettingGuideDocx({
    filePath: EXCEL,
    outputPath: `${OUT}/Sangfor_설정가이드_v6_감사항목개별표시.docx`,
  });
  console.log('DOCX:', JSON.stringify(docx, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
