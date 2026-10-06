// Runs an Electron script (e.g. scripts/record-frames.js) with ELECTRON_RUN_AS_NODE cleared,
// like start.js does for the app.
const { spawn } = require('node:child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, process.argv.slice(2), { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
