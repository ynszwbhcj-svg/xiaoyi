#!/usr/bin/env node

/**
 * Post-build script to fix openclaw import paths
 * Replaces "openclaw/dist/plugin-sdk/index.js" with "openclaw/plugin-sdk"
 */

const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');

function fixImports(dir) {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      fixImports(fullPath);
    } else if (file.endsWith('.js')) {
      let content = fs.readFileSync(fullPath, 'utf8');

      // Replace require("openclaw/dist/plugin-sdk/index.js") with require("openclaw/plugin-sdk")
      const original = content;
      content = content.replace(
        /require\("openclaw\/dist\/plugin-sdk\/index\.js"\)/g,
        'require("openclaw/plugin-sdk")'
      );

      if (content !== original) {
        fs.writeFileSync(fullPath, content, 'utf8');
        console.log(`Fixed imports in: ${path.relative(distDir, fullPath)}`);
      }
    }
  }
}

console.log('Fixing openclaw import paths in dist directory...');
fixImports(distDir);
console.log('Done!');
