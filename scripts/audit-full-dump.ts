import { generateExcelBasedChangePlan } from '../packages/sangfor-product-adapters/src/index.js';

// Get ALL items (not just prioritized)
const plan = generateExcelBasedChangePlan({ 
  filePath: '/Users/jmpark/Documents/개인자료/법인 - 베를로/1. Project/202601 - 일지테크 - Total infra/## ITAC Results Updated_현대차 감사_sangfor.xlsx', 
  prioritizeOnly: false 
});
console.log('Total items (all):', plan.workPlan.length);
console.log('---');
plan.workPlan.forEach((item, i) => {
  console.log(`${i+1}. [${item.product}] no=${item.no} | ${item.requestId} | desc=${item.description.substring(0, 80)} | menu=${item.menu}`);
});
