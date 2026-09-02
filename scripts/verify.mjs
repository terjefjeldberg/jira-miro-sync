import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../src/index.js';
import { cardSvg } from '../src/cards.js';
import { config, issueKeyIsValid } from '../src/config.js';

const env = {
  JIRA_PROJECT_KEY: 'SN',
  JIRA_SITE_URL: 'https://rendradev.atlassian.net/',
  MIRO_BOARD_ID: 'board-test',
};

const cfg = config(env);
assert.equal(cfg.jiraProjectKey, 'SN');
assert.equal(cfg.jiraSiteUrl, 'https://rendradev.atlassian.net');
assert.equal(cfg.layout.columns.length, 6);
assert.equal(cfg.overlapThreshold, 0.6);
assert.equal(issueKeyIsValid('SN-123', env), true);
assert.equal(issueKeyIsValid('XX-123', env), false);
assert.equal(config({ ...env, STATUS_OVERLAP_THRESHOLD: '2' }).overlapThreshold, 1);
assert.equal(config({ ...env, STATUS_OVERLAP_THRESHOLD: '-1' }).overlapThreshold, 0);

const svg = cardSvg({
  issueKey: 'SN-123',
  summary: 'Verification card',
  priority: 'High',
  assignee: 'Test User',
  workType: 'Bug',
});
assert.match(svg, /SN-123/);
assert.match(svg, /Verification card/);
assert.match(svg, /#FD9DE8/);

const health = await worker.fetch(new Request('https://worker.test/health'), env);
assert.equal(health.status, 200);
const healthBody = await health.json();
assert.equal(healthBody.ok, true);
assert.equal(healthBody.projectKey, 'SN');

let appSource = '';
for (const path of ['/app.js', '/panel.js']) {
  const response = await worker.fetch(new Request(`https://worker.test${path}`), env);
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.doesNotThrow(() => new Function(source), `${path} must be valid browser JavaScript`);
  if (path === '/app.js') appSource = source;
}
assert.match(appSource, /experimental:items:update/);
assert.doesNotMatch(appSource, /setInterval\s*\(/, 'Miro drag sync must stay event-driven and must not poll');

for (const path of ['/miro-app', '/miro-panel']) {
  const response = await worker.fetch(new Request(`https://worker.test${path}`), env);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /miro\.com\/app\/static\/sdk\/v2\/miro\.js/);
}

const missing = await worker.fetch(new Request('https://worker.test/no-such-route'), env);
assert.equal(missing.status, 404);

const wrangler = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
assert.match(wrangler, /main\s*=\s*"src\/index\.js"/);

const appUi = await readFile(new URL('../src/app-ui.js', import.meta.url), 'utf8');
assert.doesNotMatch(appUi, /String\.raw/, 'Active Miro app client must not be embedded in String.raw');
const appClient = await readFile(new URL('../src/app-client.js', import.meta.url), 'utf8');
assert.match(appClient, /export async function appClientMain/);

console.log('Compact Worker verification passed.');
