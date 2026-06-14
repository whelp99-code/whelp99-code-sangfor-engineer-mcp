import { generateExcelBasedChangePlan } from '../packages/sangfor-product-adapters/src/index.js';

const plan = generateExcelBasedChangePlan({ 
  filePath: '/Users/jmpark/Documents/개인자료/법인 - 베를로/1. Project/202601 - 일지테크 - Total infra/## ITAC Results Updated_현대차 감사_sangfor.xlsx', 
  prioritizeOnly: false 
});

const targetNos = ['3', '7', '12', '13', '19', '20', '28'];

for (const item of plan.workPlan ?? []) {
  if (item.no && targetNos.includes(item.no)) {
    console.log(`=== REQ-${item.no} ===`);
    console.log(`설정: ${item.setting}`);
    console.log(`설명: ${item.description}`);
    console.log(`현재 Gap: ${item.currentGap}`);
    console.log(`증적: ${item.evidence.join(', ')}`);
    console.log(`Dry-run: ${item.dryRunAction}`);
    console.log(`제품: ${item.product}`);
    console.log();
  }
}
