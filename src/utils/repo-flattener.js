const fs = require('fs-extra');
const path = require('path');

const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.idea',
  '.gradle',
  '.next',
  '.turbo',
  'build',
  'dist',
  'coverage',
  'DerivedData'
]);

const DEFAULT_IGNORED_FILES = new Set([
  '.DS_Store'
]);

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isBinaryBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

async function collectFiles(rootDir, currentDir = rootDir, output = []) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath);

    if (entry.isDirectory()) {
      if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
      await collectFiles(rootDir, absolutePath, output);
      continue;
    }

    if (!entry.isFile()) continue;
    if (DEFAULT_IGNORED_FILES.has(entry.name)) continue;
    output.push({ absolutePath, relativePath });
  }

  return output;
}

async function flattenRepositoryToXml(inputDir, outputFile) {
  const files = await collectFiles(inputDir);
  const xmlChunks = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<repository root="${escapeXml(path.resolve(inputDir))}">`
  ];

  for (const file of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const buffer = await fs.readFile(file.absolutePath);
    const stats = await fs.stat(file.absolutePath);
    const binary = isBinaryBuffer(buffer);

    xmlChunks.push(
      `  <file path="${escapeXml(file.relativePath)}" size="${stats.size}" binary="${binary}">`
    );

    if (binary) {
      xmlChunks.push('    <![CDATA[[binary omitted]]]>');
    } else {
      xmlChunks.push(`    <![CDATA[${buffer.toString('utf8').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`);
    }

    xmlChunks.push('  </file>');
  }

  xmlChunks.push('</repository>');
  await fs.ensureDir(path.dirname(outputFile));
  await fs.writeFile(outputFile, `${xmlChunks.join('\n')}\n`, 'utf8');

  return { fileCount: files.length, outputFile };
}

module.exports = {
  flattenRepositoryToXml
};
