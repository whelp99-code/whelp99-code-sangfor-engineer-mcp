import { generateExcelBasedChangePlan } from '../packages/sangfor-product-adapters/src/index.js';

const plan = generateExcelBasedChangePlan({ 
  filePath: '/Users/jmpark/Documents/개인자료/법인 - 베를로/1. Project/202601 - 일지테크 - Total infra/## ITAC Results Updated_현대차 감사_sangfor.xlsx', 
  prioritizeOnly: true 
});
console.log('Total items:', plan.workPlan.length);
console.log('---');
plan.workPlan.forEach((item, i) => {
  console.log(`${i+1}. [${item.product}] ${item.requestId} | no=${item.no} | ${item.setting} | menu: ${item.menu}`);
});
