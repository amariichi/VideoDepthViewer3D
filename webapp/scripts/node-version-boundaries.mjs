import assert from 'node:assert/strict';
import {test} from 'node:test';
import {supported} from './check-node-version.mjs';
test('requires a patched supported Node release', () => {
  for (const version of ['22.23.5', '22.24.0', '24.22.3', '24.23.0', '26.13.1', '26.14.0']) assert.equal(supported(version), true, version);
  for (const version of ['20.20.0', '22.23.4', '24.22.1', '24.22.2', '26.13.0', '27.0.0', '24.22.3-rc.1', 'bad']) assert.equal(supported(version), false, version);
});
