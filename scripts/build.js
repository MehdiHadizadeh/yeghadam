// Builds the injected script from src/core.js + src/ui.js for both shells.
//   npm run build
// Writes:
//   dist/extension/                         unpacked browser extension (load it as is, or zip it)
//   android/app/src/main/assets/yeghadam.js the script the Android app injects
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const at = (...p) => path.join(root, ...p);
const { version } = require(at('package.json'));

const banner = (shell) => `/*
 * Yeghadam ${version} (${shell}). Generated from src/core.js and src/ui.js by scripts/build.js.
 * Only asks Snapp for price quotes (and reads public map tiles). It never requests a ride.
 */
`;
const body = fs.readFileSync(at('src', 'core.js'), 'utf8') + '\n' + fs.readFileSync(at('src', 'ui.js'), 'utf8');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log('wrote', path.relative(root, file));
}

// browser extension
const ext = at('dist', 'extension');
fs.rmSync(ext, { recursive: true, force: true });
const manifest = JSON.parse(fs.readFileSync(at('extension', 'manifest.json'), 'utf8'));
manifest.version = version;
write(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
write(path.join(ext, 'content.js'), banner('browser extension') + body);
for (const icon of fs.readdirSync(at('extension', 'icons'))) {
  fs.mkdirSync(path.join(ext, 'icons'), { recursive: true });
  fs.copyFileSync(at('extension', 'icons', icon), path.join(ext, 'icons', icon));
}

// Android
write(at('android', 'app', 'src', 'main', 'assets', 'yeghadam.js'), banner('Android') + body);
