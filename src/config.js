export const DEFAULT_LAYOUT = {
  board: { left: 438.36642375544034, right: 5303.436262036128, top: 434.257014599023, bottom: 3045.734778444852 },
  columns: [
    { status: 'Todo', left: 1468.7903676550886, right: 2551.696467655089, targetX: 1990.8399296925127 },
    { status: 'In progress', left: 2564.6113791667394, right: 3277.6028791667395, targetX: 2923.455009676509 },
    { status: 'Functional review', left: 3289.4484150169965, right: 3651.451815016996, targetX: 3472.938505190192 },
    { status: 'Code review', left: 3662.9922412433402, right: 4020.66884124334, targetX: 3842.7526347392704 },
    { status: 'Approved', left: 4033.200178788891, right: 4680.471778788891, targetX: 4350.752924110384 },
    { status: 'Merged', left: 4692.4616140640555, right: 5284.738514064056, targetX: 4983.202615160219 },
  ],
};

export const WORK_TYPE_COLORS = {
  bug: '#FD9DE8',
  improvement: '#B7D3FE',
  spike: '#FFEB7F',
  'new feature': '#D7F2AC',
  'hotfix candidate': '#FFB677',
  'task/config/doc/test': '#89E8E0',
};

export const FIXED_MIRO_USERS = {
  '3458764589815876301': 'Kristoffer Rask',
  '3074457347700027993': 'Tim Chipman',
  '3074457362562828515': 'Rupert Hanna',
  '3074457346177807607': 'Robin Grønvold',
  '3458764570480950130': 'Terje Fjeldberg',
  '3074457345777323592': 'Ole Kristian Kvarsvik',
  '3458764555898556023': 'Masud Mahamed',
  '3074457366743197593': 'Jostein Edvardsen',
  '3074457346139208205': 'Kristian Samuelsen',
  '3458764561305764945': 'Mathias Hellqvist',
  '99386030': 'Christoffer Henne',
  '3458764544817410612': 'Zandrex Ramos Camagon',
  '3074457352976810809': 'Erwin Berkers',
  '3074457352976810811': 'Manuel Gonzalez',
  '3074457346177899037': 'Lirian Rusiti',
  '3074457345929923505': 'Andrea Dallera',
  '3458764634714855820': 'Gjermund Madsen',
  '3458764636149340448': 'Prem Wycisk',
  '3458764648050732223': 'Viktor Österdahl',
  '3458764666715690327': 'Josef Aden',
  '3458764650779944565': 'Igor Lima',
  '3458764617111887828': 'Toda Yoshinori',
  '3458764681147070850': 'Elias Vesterlund',
  '3458764636149340450': 'Rafal Mnich',
};

const asNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const escapeRegex = value => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function config(env) {
  let layout = DEFAULT_LAYOUT;
  if (env.WORKFLOW_LAYOUT_JSON) {
    try {
      const parsed = JSON.parse(env.WORKFLOW_LAYOUT_JSON);
      if (parsed?.board && Array.isArray(parsed?.columns)) layout = parsed;
    } catch {}
  }
  return {
    jiraProjectKey: String(env.JIRA_PROJECT_KEY || 'SN').trim().toUpperCase(),
    jiraSiteUrl: String(env.JIRA_SITE_URL || 'https://rendradev.atlassian.net').replace(/\/+$/, ''),
    incomingFrameId: String(env.MIRO_INCOMING_FRAME_ID || '3458764681916843188').trim(),
    layout,
    overlapThreshold: clamp(asNumber(env.STATUS_OVERLAP_THRESHOLD, 0.6), 0, 1),
    fields: {
      testArea: env.JIRA_FIELD_TEST_AREA || 'customfield_10832',
      originalMiroCreated: env.JIRA_FIELD_ORIGINAL_MIRO_CREATED || 'customfield_11207',
      bugRepro: env.JIRA_FIELD_BUG_REPRO || 'customfield_10868',
      bugCustomer: env.JIRA_FIELD_BUG_CUSTOMER || 'customfield_11174',
      nfDropdown1: env.JIRA_FIELD_NF_DROPDOWN_1 || 'customfield_10792',
      nfText1: env.JIRA_FIELD_NF_TEXT_1 || 'customfield_10869',
      nfText2: env.JIRA_FIELD_NF_TEXT_2 || 'customfield_10870',
      nfDropdown2: env.JIRA_FIELD_NF_DROPDOWN_2 || 'customfield_10832',
      taskRequired: env.JIRA_FIELD_TASK_REQUIRED || 'customfield_10872',
    },
    card: { width: 189, height: 123.12 },
    incoming: { marginX: 36, marginY: 36, gapX: 20, gapY: 30, layerX: 24, layerY: 24, maxLayers: 12 },
  };
}

export const normalizeIssueKey = value => String(value ?? '').trim().toUpperCase();
export const normalizeStatus = value => String(value ?? '').trim().toLowerCase();
export const issueKeyIsValid = (value, env) => new RegExp(`^${escapeRegex(config(env).jiraProjectKey)}-\\d+$`, 'i').test(String(value ?? '').trim());
export const customMapKey = key => `custom-card:${normalizeIssueKey(key)}`;
export const reporterMapKey = id => `reporter-account:${String(id ?? '').trim()}`;
export const freezeKey = key => `conversion-freeze:${normalizeIssueKey(key)}`;
export const directPendingKey = key => `conversion-direct-pending:${normalizeIssueKey(key)}`;
export const stickyIssueKey = stickyId => `conversion-sticky:${String(stickyId ?? '').trim()}`;
