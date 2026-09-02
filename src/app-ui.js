import { config } from './config.js';
import { text } from './auth.js';
import { appClientMain } from './app-client.js';

const sdk = '<script src="https://miro.com/app/static/sdk/v2/miro.js"></script>';

export function renderApp() {
  return text(`<!doctype html><html><head><meta charset="utf-8"><title>Jira to Miro position sync</title>${sdk}</head><body><script src="/app.js?v=13"></script></body></html>`, 'text/html; charset=utf-8');
}

export function renderAppClient(env) {
  const cfg = config(env);
  const runtime = {
    layout: cfg.layout,
    threshold: cfg.overlapThreshold,
    projectKey: cfg.jiraProjectKey,
  };
  return text(`(${appClientMain.toString()})(${JSON.stringify(runtime)}).catch(console.error);`, 'application/javascript; charset=utf-8');
}
