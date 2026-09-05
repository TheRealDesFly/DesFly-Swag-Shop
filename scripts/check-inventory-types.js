// Check the inventory modules against the real generated Wix declarations.
// Existing backend modules are resolved for their inferred exports; diagnostics
// are deliberately scoped to these two inventory modules and compiler options.
const path = require('node:path');
const ts = require('typescript');
const { configureWixTypes } = require('./configure-wix-types');

configureWixTypes();
const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(projectRoot, '.wix/types/backend/jsconfig.json');
const read = ts.readConfigFile(configPath, ts.sys.readFile);
if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
const config = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
const files = ['src/backend/isendInventoryPlan.js', 'src/backend/isendInventorySync.js']
  .map((filename) => path.join(projectRoot, filename));
const program = ts.createProgram(files, {
  ...config.options, noEmit: true, composite: false, incremental: false,
  strict: true, skipLibCheck: true,
});
const diagnostics = [...config.errors, ...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
for (const filename of files) {
  const source = program.getSourceFile(filename);
  if (!source) throw new Error(`TypeScript did not load ${path.basename(filename)}`);
  diagnostics.push(...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source));
}
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (filename) => filename,
    getCurrentDirectory: () => projectRoot,
    getNewLine: () => '\n',
  }));
  process.exitCode = 1;
} else console.log(`Inventory type check passed (TypeScript ${ts.version}, real Wix types, strict mode).`);
