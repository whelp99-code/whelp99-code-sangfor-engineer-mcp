import { fetchText, parseKbCategoryNavigation } from '../packages/sangfor-collector/src/index.js';
const kb = 'https://knowledgebase.sangfor.com';
const nav = JSON.parse(await fetchText(`${kb}/category-navigation.json`));
console.log(parseKbCategoryNavigation(nav, kb).length);
