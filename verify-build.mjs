import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [root = process.cwd(), relative = 'lib/client.js'] = process.argv.slice(2);
const text = readFileSync(join(root, relative), 'utf8');

const needles = [
  'id: "dsh-model-select-test"',
  '...dshModelTestCells(group, model),',
  'function dshModelTestCells(group, model)',
  'dshModelTestInit();',
  'dshModelTestCodeLabels',
  'id: "@deepseek-ai/dsh-client-ui-model-selection"',
  'className: ModelSelect_module_css_default.check',
];
for (const needle of needles) {
  const count = text.split(needle).length - 1;
  console.log(count, needle);
}
