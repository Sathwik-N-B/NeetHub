import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const srcDir = path.join(projectRoot, 'src');

// Ensure directories exist
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

// Copy popup.html
const popupSrc = path.join(srcDir, 'popup', 'popup.html');
const popupDest = path.join(distDir, 'src', 'popup', 'popup.html');
ensureDir(path.dirname(popupDest));
fs.copyFileSync(popupSrc, popupDest);
console.log('✓ Copied popup.html');

// Copy options.html
const optionsSrc = path.join(srcDir, 'options', 'options.html');
const optionsDest = path.join(distDir, 'src', 'options', 'options.html');
ensureDir(path.dirname(optionsDest));
fs.copyFileSync(optionsSrc, optionsDest);
console.log('✓ Copied options.html');

// Copy manifest.json
const manifestSrc = path.join(projectRoot, 'public', 'manifest.json');
const manifestDest = path.join(distDir, 'manifest.json');
fs.copyFileSync(manifestSrc, manifestDest);
console.log('✓ Copied manifest.json');
