// Launches the app. Terminals inside other Electron apps (VS Code, T3 Code)
// can set ELECTRON_RUN_AS_NODE, which makes Electron start as plain Node.
const { spawn } = require('node:child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
