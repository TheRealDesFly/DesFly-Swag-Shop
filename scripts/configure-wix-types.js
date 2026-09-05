// Wix regenerates these ignored editor projects. Apply the same resolver
// override after regeneration without changing the vendor type definitions.
const fs = require('node:fs');
const path = require('node:path');

function configureWixTypes() {
  const root = path.resolve(__dirname, '..', '.wix', 'types');
  if (!fs.existsSync(root)) return 0;
  let updated = 0;
  for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const filename = path.join(root, directory.name, 'jsconfig.json');
    if (!fs.existsSync(filename)) continue;
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const options = config.compilerOptions || {};
    if (options.module === 'esnext' && options.moduleResolution === 'bundler') continue;
    config.compilerOptions = { ...options, module: 'esnext', moduleResolution: 'bundler' };
    fs.writeFileSync(filename, `${JSON.stringify(config, null, 2)}\n`);
    updated += 1;
  }
  return updated;
}
if (require.main === module) console.log(`Updated ${configureWixTypes()} generated Wix editor projects.`);
module.exports = { configureWixTypes };
