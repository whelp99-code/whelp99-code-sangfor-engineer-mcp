import { generateExcelBasedChangePlan } from '../packages/sangfor-product-adapters/src/index.js';
const plan = generateExcelBasedChangePlan({ filePath: '/Users/jmpark/Documents/개인자료/법인 - 베를로/1. Project/202601 - 일지테크 - Total infra/## ITAC Results Updated_현대차 감사_sangfor.xlsx', prioritizeOnly: false });
plan.workPlan.sort((a, b) => parseInt(a.no ?? '999') - parseInt(b.no ?? '999'));
for (const item of plan.workPlan) {
  console.log(`${item.no?.padStart(2)} | ${item.product.padEnd(20)} | ${item.setting.substring(0, 40)}`);
}
