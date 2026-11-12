import console from 'node:console';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Minimum supported releases from the November 2026 Node.js security update.
const minimum = {22: [23, 5], 24: [22, 3], 26: [13, 1]};
export function supported(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  const floor = minimum[major];
  return Boolean(floor && (minor > floor[0] || (minor === floor[0] && patch >= floor[1])));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && !supported(process.versions.node)) {
  console.error(`Unsupported Node.js ${process.versions.node}. Use 22.23.5+, 24.22.3+, or 26.13.1+ within those release lines.`);
  process.exitCode = 1;
}
