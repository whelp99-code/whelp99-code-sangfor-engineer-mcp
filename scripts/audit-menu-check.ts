import { generateExcelBasedChangePlan } from '../packages/sangfor-product-adapters/src/index.js';

const plan = generateExcelBasedChangePlan({ 
  filePath: '/Users/jmpark/Documents/개인자료/법인 - 베를로/1. Project/202601 - 일지테크 - Total infra/## ITAC Results Updated_현대차 감사_sangfor.xlsx', 
  prioritizeOnly: false 
});

// 슬라이드 12,13,14 = 감사 #9, #10, #11
const targetNos = ['8', '9', '10', '11'];
const sorted = plan.workPlan
  .filter(item => item.no && targetNos.includes(item.no))
  .sort((a, b) => parseInt(a.no!) - parseInt(b.no!));

for (const item of sorted) {
  console.log(`=== 감사 #${item.no} ===`);
  console.log(`제품: ${item.product}`);
  console.log(`설정: ${item.setting}`);
  console.log(`설명: ${item.description}`);
  console.log(`메뉴: ${item.menu}`);
  console.log(`현재 Gap: ${item.currentGap}`);
  console.log(`Dry-run: ${item.dryRunAction}`);
  console.log();
}
