#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
async function source(relative) {
  return readFile(path.join(root, relative), 'utf8').catch(err => {
    if (err?.code === 'ENOENT' && (relative.startsWith('test/') || relative === 'package-lock.json')) {
      warnings.push(`${relative} omitted from distributed npm package; full test-tree checks unavailable.`);
      return '';
    }
    errors.push(`${relative}: ${err.message}`);
    return '';
  });
}
const [pkgSource, lockSource, fixtures, execute, testCode] = await Promise.all([
  source('package.json'),source('package-lock.json'),source('test/fixtures.js'),
  source('src/server/execute.js'),source('test/adapter.test.js'),
]);
let pkg = {}, lock = {};
try { pkg = JSON.parse(pkgSource); } catch { errors.push('package.json is not valid JSON'); }
try { lock = JSON.parse(lockSource); } catch { errors.push('package-lock.json is not valid JSON'); }
const release = pkg.version;
if (pkg.version !== release) errors.push(`Package is ${pkg.version ?? '(missing)'}, not ${release}`);
if (lockSource && (lock.version !== release || lock.packages?.['']?.version !== release))
  errors.push('package-lock.json does not match installed package version');
if (fixtures && !fixtures.includes(`FIXTURE_SUITE_VERSION = '${release}'`))
  errors.push('Test fixtures are from an incompatible release. Do not mix archive/test trees.');
if (!execute.includes('discoverModels = discoverAgyModels'))
  errors.push('Production model discovery and test injection are not from this release.');
if (testCode && !testCode.includes("billingType,'external_cli_unverified'"))
  errors.push('adapter.test.js still expects the old pricing / billing contract.');
if (/estimateCostUsd\s*\(\s*cfg\.model\s*,/.test(execute))
  errors.push('Old positional estimateCostUsd call remains in execute.js.');
if (Number(process.versions.node.split('.')[0]) < 22)
  warnings.push(`Node ${process.version} is below the package engine minimum (22.16.0)`);
console.log(`Adapter version: ${pkg.version ?? 'unknown'} · Node: ${process.version}`);
if (errors.length) {
  console.error('FAILED — mixed, incomplete, or obsolete files:');
  for (const error of errors) console.error(` - ${error}`);
  console.error('Install a complete, version-consistent adapter package or merge changes carefully.');
  process.exitCode = 1;
} else {
  console.log('PASS — source, test fixtures, pricing contract and package lock are version-consistent.');
}
for (const warning of warnings) console.warn(`WARNING: ${warning}`);
