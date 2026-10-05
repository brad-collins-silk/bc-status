#!/usr/bin/env node
// Polls BigCommerce's Statuspage (status.bigcommerce.com) and posts each new
// incident update to Slack as a styled Block Kit message.
//
// Env vars:
//   SLACK_WEBHOOK_URL   Slack incoming webhook (required unless DRY_RUN=1)
//   COMPONENT_FILTER    Optional comma list, e.g. "Checkout,B2B Edition,Storefront"
//                       (incidents with no components listed always pass)
//   STATE_FILE          Defaults to state.json
//   DRY_RUN=1           Print payloads instead of posting
// Flags:
//   --test              Post the most recent incident's latest update (style check)

import { readFile, writeFile } from 'node:fs/promises';

const STATUS_BASE = process.env.STATUS_BASE || 'https://status.bigcommerce.com';
const WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const STATE_FILE = process.env.STATE_FILE || 'state.json';
const DRY_RUN = process.env.DRY_RUN === '1';
const TEST = process.argv.includes('--test');
const COMPONENT_FILTER = (process.env.COMPONENT_FILTER || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const MAX_SEEN = 1000;

const STATUS_META = {
  investigating: { emoji: '🔍', label: 'Investigating' },
  identified: { emoji: '🎯', label: 'Identified' },
  monitoring: { emoji: '👀', label: 'Monitoring' },
  resolved: { emoji: '✅', label: 'Resolved' },
  postmortem: { emoji: '📝', label: 'Postmortem' },
};
const IMPACT_META = {
  critical: { emoji: '🔴', label: 'Critical', color: '#E01E5A' },
  major: { emoji: '🟠', label: 'Major', color: '#E8912D' },
  minor: { emoji: '🟡', label: 'Minor', color: '#ECB22E' },
  none: { emoji: '🔵', label: 'None', color: '#3AA3E3' },
  maintenance: { emoji: '🛠️', label: 'Maintenance', color: '#3AA3E3' },
};
const RESOLVED_COLOR = '#2EB67D';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const slackDate = (iso) => `<!date^${unix(iso)}^{date_short_pretty} at {time}|${iso}>`;
const titleCase = (s) => String(s || 'update').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function duration(startIso, endIso) {
  const mins = Math.max(0, Math.round((new Date(endIso) - new Date(startIso)) / 60000));
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${mins % 60}m` : `${mins}m`;
}

function buildMessage(incident, update) {
  const resolved = ['resolved', 'postmortem'].includes(update.status);
  const impact = IMPACT_META[incident.impact] || IMPACT_META.none;
  const status = STATUS_META[update.status] || { emoji: '🔄', label: titleCase(update.status) };
  const updates = incident.incident_updates || [];
  const isFirst = updates.length && updates[updates.length - 1].id === update.id; // API lists newest first
  const headerEmoji = resolved ? '✅' : impact.emoji;
  const components = (incident.components || []).map((c) => c.name).join(', ') || 'Not specified';
  const link = incident.shortlink || `${STATUS_BASE}/incidents/${incident.id}`;
  const start = incident.started_at || incident.created_at;
  const startedText = resolved && incident.resolved_at
    ? `${slackDate(start)}\nLasted ${duration(start, incident.resolved_at)}`
    : slackDate(start);
  const kind = isFirst ? 'New incident reported' : resolved ? 'Incident resolved' : 'Incident update';
  const body = esc(update.body || '(no details provided)').replace(/\n/g, '\n>');

  return {
    text: `${headerEmoji} BigCommerce ${status.label}: ${incident.name}`, // notification fallback
    attachments: [{
      color: resolved ? RESOLVED_COLOR : impact.color,
      blocks: [
        { type: 'header', text: { type: 'plain_text', emoji: true, text: trunc(`${headerEmoji} BigCommerce: ${incident.name}`, 150) } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `*${kind}*` }] },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: `*Status*\n${status.emoji} ${status.label}` },
          { type: 'mrkdwn', text: `*Impact*\n${impact.label}` },
          { type: 'mrkdwn', text: `*Affected*\n${esc(components)}` },
          { type: 'mrkdwn', text: `*Started*\n${startedText}` },
        ] },
        { type: 'section', text: { type: 'mrkdwn', text: trunc(`*Latest update*\n>${body}`, 3000) } },
        { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View on status page' }, url: link }] },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Posted ${slackDate(update.display_at || update.created_at)} · <${STATUS_BASE}|status.bigcommerce.com>` }] },
      ],
    }],
  };
}

function matchesFilter(incident) {
  if (!COMPONENT_FILTER.length) return true;
  const names = (incident.components || []).map((c) => c.name.toLowerCase());
  if (!names.length) return true;
  return names.some((n) => COMPONENT_FILTER.some((f) => n.includes(f)));
}

async function fetchIncidents() {
  const res = await fetch(`${STATUS_BASE}/api/v2/incidents.json`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Statuspage returned ${res.status}`);
  return (await res.json()).incidents || [];
}

async function post(payload) {
  if (DRY_RUN) { console.log(JSON.stringify(payload, null, 2)); return; }
  const res = await fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Slack returned ${res.status}: ${await res.text()}`);
}

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return null; }
}
async function saveState(seen) {
  const data = { seen: seen.slice(-MAX_SEEN), updatedAt: new Date().toISOString() };
  await writeFile(STATE_FILE, JSON.stringify(data, null, 2) + '\n');
}

async function main() {
  if (!DRY_RUN && !WEBHOOK) throw new Error('SLACK_WEBHOOK_URL is not set');
  const incidents = await fetchIncidents();

  if (TEST) {
    const inc = incidents[0];
    if (!inc) return console.log('No incidents to use for a test message.');
    await post(buildMessage(inc, inc.incident_updates[0]));
    return console.log(`Sent test message for "${inc.name}".`);
  }

  const all = incidents.flatMap((inc) => (inc.incident_updates || []).map((u) => ({ inc, u })));
  const state = await loadState();
  if (!state) {
    await saveState(all.map((x) => x.u.id));
    return console.log(`First run: recorded ${all.length} existing updates without posting.`);
  }

  const seenSet = new Set(state.seen);
  const seen = [...state.seen];
  const fresh = all
    .filter((x) => !seenSet.has(x.u.id))
    .sort((a, b) => new Date(a.u.created_at) - new Date(b.u.created_at));

  try {
    for (const { inc, u } of fresh) {
      if (matchesFilter(inc)) {
        await post(buildMessage(inc, u));
        console.log(`Posted: ${inc.name} [${u.status}]`);
      }
      seen.push(u.id);
    }
  } finally {
    await saveState(seen); // keep progress even if Slack fails mid-run
  }
  if (!fresh.length) console.log('No new updates.');
}

main().catch((err) => { console.error(err); process.exit(1); });
