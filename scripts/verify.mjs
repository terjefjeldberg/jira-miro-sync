import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../src/index.js';
import { cardSvg } from '../src/cards.js';
import { config, issueKeyIsValid } from '../src/config.js';
import { getCardData } from '../src/jira.js';

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
  assigneeAccountId: 'account-test-user',
  workType: 'Bug',
});
assert.match(svg, /SN-123/);
assert.match(svg, /Verification/);
assert.match(svg, /card/);
assert.match(svg, /#FD9DE8/);
assert.match(svg, /Assignee: Test User/);
assert.match(svg, /<rect x="106" y="80" width="80" height="18"/);
assert.match(svg, /<text x="146" y="92\.8" text-anchor="middle"/);

const sameAccountDifferentName = cardSvg({
  issueKey: 'SN-123', summary: 'Verification card', priority: 'High', assignee: 'Renamed User',
  assigneeAccountId: 'account-test-user', workType: 'Bug',
});
const badgeColor = value => value.match(/<rect x="106" y="80" width="80" height="18" rx="4" fill="(#[A-F0-9]+)"/)?.[1];
assert.equal(badgeColor(svg), badgeColor(sameAccountDifferentName));
const differentAccount = cardSvg({
  issueKey: 'SN-123', summary: 'Verification card', priority: 'High', assignee: 'Another User',
  assigneeAccountId: 'account-another-user', workType: 'Bug',
});
assert.notEqual(badgeColor(svg), badgeColor(differentAccount));

const unassignedSvg = cardSvg({ issueKey: 'SN-125', summary: 'Unassigned card', priority: 'Low', assignee: 'Unassigned', workType: 'Bug' });
assert.match(unassignedSvg, /fill="#D1D5DB"/);
const longAssigneeSvg = cardSvg({ issueKey: 'SN-127', summary: 'Long assignee', priority: 'Low', assignee: 'Christoffer Henne', assigneeAccountId: 'account-christoffer', workType: 'Bug' });
assert.match(longAssigneeSvg, /Christoffer Hen\.\.\./);
assert.doesNotMatch(longAssigneeSvg, /…/);

const oldFetch = globalThis.fetch;
globalThis.fetch = async url => {
  assert.match(String(url), /assignee/);
  return new Response(JSON.stringify({ fields: {
    summary: 'Account ID test', priority: { name: 'Medium' },
    assignee: { displayName: 'Stable Name', accountId: 'account-123' },
    issuetype: { name: 'Bug' }, status: { name: 'Todo' },
  } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const cardData = await getCardData(env, 'SN-126');
assert.equal(cardData.assignee, 'Stable Name');
assert.equal(cardData.assigneeAccountId, 'account-123');
globalThis.fetch = oldFetch;

const hotfixSvg = cardSvg({
  issueKey: 'SN-124', summary: 'Hotfix bug', priority: 'High', assignee: 'Test User', workType: 'Bug', hotfixCandidate: true,
});
assert.match(hotfixSvg, /#FFB677/);

const health = await worker.fetch(new Request('https://worker.test/health'), env);
assert.equal(health.status, 200);
const healthBody = await health.json();
assert.equal(healthBody.ok, true);
assert.equal(healthBody.projectKey, 'SN');

for (const path of ['/app.js', '/panel.js', '/comments.js']) {
  const response = await worker.fetch(new Request(`https://worker.test${path}`), env);
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.doesNotThrow(() => new Function(source), `${path} must be valid browser JavaScript`);
  if (path === '/app.js') {
    assert.match(source, /previousX/);
    assert.match(source, /previousY/);
    assert.match(source, /rollback-custom-card/);
    assert.match(source, /previousParentId/);
    assert.doesNotMatch(source, /rollbacks\.delete/);
    assert.doesNotMatch(source, /eventItem\?\{x:Number\(eventItem\.x\)/);
  }
  if (path === '/panel.js') assert.match(source, /refresh-custom-cards/);
}

for (const path of ['/miro-app', '/miro-panel']) {
  const response = await worker.fetch(new Request(`https://worker.test${path}`), env);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /miro\.com\/app\/static\/sdk\/v2\/miro\.js/);
}

const missing = await worker.fetch(new Request('https://worker.test/no-such-route'), env);
assert.equal(missing.status, 404);

const wrangler = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
assert.match(wrangler, /main\s*=\s*"src\/index\.js"/);

console.log('Compact Worker verification passed.');
