import fs from 'fs';
import path from 'path';
import archiver from 'archiver';

const distDir = path.resolve('dist');
const outFile = path.resolve('neethub-dist.zip');

if (!fs.existsSync(distDir)) {
  console.error('dist folder not found. Run npm run build first.');
  process.exit(1);
}

const output = fs.createWriteStream(outFile);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`Created ${outFile} (${archive.pointer()} bytes)`);
});

archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);
archive.directory(distDir, false);
archive.finalize();
