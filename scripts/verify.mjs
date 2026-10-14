import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import worker from '../src/index.js';
import { cardSvg } from '../src/cards.js';
import { config, issueKeyIsValid } from '../src/config.js';
import { getCardData, resolveReporter } from '../src/jira.js';

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
const accentedAssigneeSvg = cardSvg({ issueKey: 'SN-128', summary: 'Accented assignee', priority: 'Low', assignee: 'Manuel González', assigneeAccountId: 'account-manuel', workType: 'Bug' });
assert.match(accentedAssigneeSvg, /Manuel Gonz/);
assert.doesNotMatch(accentedAssigneeSvg, /González|�/);

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

// The creator ID read from the selected sticky resolves without a Jira name search.
globalThis.fetch = async url => {
  assert.match(String(url), /api\.miro\.com\/v2\/boards\/board-test\/items\/sticky-gjermund$/);
  return new Response(JSON.stringify({ type: 'sticky_note', createdBy: { id: '3458764636162900745', name: 'Gjermund' }, createdAt: '2026-10-13T08:00:00Z' }), { status: 200 });
};
const gjermundReporter = await resolveReporter({ ...env, MIRO_TOKEN: 'miro-token' }, 'sticky-gjermund', '3458764636162900745');
assert.equal(gjermundReporter.ok, true);
assert.equal(gjermundReporter.accountId, '712020:0c510c44-97d9-40c1-b8e1-0b99638dc289');
assert.equal(gjermundReporter.creatorName, 'Gjermund');
assert.equal(gjermundReporter.source, 'fixed-miro-jira-account');
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
    const handlers = new Map(), modals = [], actions = [];
    const card = { id: 'card-1', type: 'image', title: 'CUSTOM_JIRA_CARD:SN-123', x: 100, y: 100, width: 189, height: 102 };
    let images = [];
    const ui = {
      on: async (name, handler) => { handlers.set(name, handler); },
      canOpenModal: async () => true,
      openModal: async options => { modals.push(options); },
    };
    await runInNewContext(source, {
      miro: { board: {
        ui,
        experimental: { action: { register: async action => { actions.push(action); } } },
        get: async () => images,
        getById: async () => card,
        getSelection: async () => [card],
        getInfo: async () => ({ id: 'board-test' }),
      } },
      setTimeout: () => 1, setInterval: () => 1, clearTimeout: () => {}, clearInterval: () => {},
      console,
    });
    await new Promise(resolve => setImmediate(resolve));
    images = [card];
    await handlers.get('selection:update')({ items: [card] });
    assert.equal(modals.length, 0, 'Selecting a Jira card must leave the board interactive');
    assert.equal(actions[0]?.event, 'open-jira-comments');
    assert.equal(actions[0]?.predicate?.title?.$regex, '^CUSTOM_JIRA_CARD:SN-[0-9]+$');
    await handlers.get('custom:open-jira-comments')({ items: [card] });
    assert.equal(modals.length, 1, 'The card action must open comments');
    assert.equal(modals[0].fullscreen, true);
    assert.equal(modals[0].data.issueKey, 'SN-123');
    assert.equal(modals[0].data.itemId, 'card-1');
  }
  if (path === '/panel.js') {
    assert.match(source, /refresh-custom-cards/);
    assert.match(source, /assignee-color-legend/);
    assert.match(source, /set-assignee-color/);
    assert.match(source, /search-card-summaries/);
    const element = () => ({ children: [], events: {}, textContent: '', value: '',
      addEventListener(name, handler) { this.events[name] = handler; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
    });
    const ids = Object.fromEntries(['convertButton', 'refreshCardsButton', 'refreshSelectedCardsButton', 'status', 'cardSearch', 'searchMessage', 'searchResults', 'searchReload', 'legend'].map(id => [id, element()]));
    const document = { getElementById: id => ids[id] || null, querySelector: () => null, createElement: element };
    const card = { id: 'card-1', type: 'image', data: { title: 'CUSTOM_JIRA_CARD:SN-123' } };
    const zoomed = [];
    let closed = false;
    let summaryRequests = 0;
    runInNewContext(source, { document, miro: { board: {
      get: async () => [card], getById: async () => card, getInfo: async () => ({ id: 'board-test' }),
      getIdToken: async () => 'token', viewport: { zoomTo: async item => zoomed.push(item) },
      ui: { closePanel: async () => { closed = true; } },
    } }, fetch: async (_url, init) => {
      summaryRequests += 1;
      assert.equal(JSON.parse(init.body).cards[0].issueKey, 'SN-123');
      return new Response(JSON.stringify({ ok: true, cards: [{ issueKey: 'SN-123', summary: 'Searchable Jira summary' }] }), { status: 200 });
    }, console });
    ids.cardSearch.value = 'searchable';
    await ids.cardSearch.events.input();
    assert.equal(ids.searchResults.children.length, 1);
    assert.equal(ids.searchResults.children[0].children[1].textContent, 'Searchable Jira summary');
    await ids.searchResults.children[0].events.click();
    assert.equal(zoomed[0], card);
    assert.equal(closed, false, 'The search panel should remain open after zooming');
    ids.cardSearch.value = 'SN-123';
    await ids.cardSearch.events.input();
    assert.equal(ids.searchResults.children.length, 1);
    assert.equal(summaryRequests, 1, 'A second search should reuse the loaded summaries');
  }
}

for (const path of ['/miro-app', '/miro-panel']) {
  const response = await worker.fetch(new Request(`https://worker.test${path}`), env);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /miro\.com\/app\/static\/sdk\/v2\/miro\.js/);
}
const panelMarkup = await (await worker.fetch(new Request('https://worker.test/miro-panel'), env)).text();
assert.match(panelMarkup, /id="cardSearch"/);
assert.match(panelMarkup, /id="searchResults"/);

const missing = await worker.fetch(new Request('https://worker.test/no-such-route'), env);
assert.equal(missing.status, 404);

const wrangler = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
assert.match(wrangler, /main\s*=\s*"src\/index\.js"/);
const indexSource = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
assert.match(indexSource, /assigneeColor\(accountId, live\.assigneeColorOverride\)/);

console.log('Compact Worker verification passed.');
