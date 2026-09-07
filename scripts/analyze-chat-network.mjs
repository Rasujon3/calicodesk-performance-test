import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = 'scenarios/chat/results/playwright/probe-network';
const latest = readdirSync(root).sort().pop();
const records = JSON.parse(
    readFileSync(path.join(root, latest, 'network.json'), 'utf8'),
);

function norm(url) {
    return url
        .replace(/workspaceId=\d+/g, 'workspaceId=<ID>')
        .replace(/\/([a-f0-9]{24,}|\d{6,})(\?|$)/g, '/<ID>$2');
}

const groups = new Map();
for (const r of records) {
    if (!r.url.includes('manobik.com')) continue;
    if (r.essential !== true) continue;
    if (/\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|eot|ico|map)$/.test(r.url)) continue;
    const key = `${r.action}|${r.method}|${r.status}|${norm(r.url)}`;
    const g = groups.get(key) ?? {
        action: r.action,
        method: r.method,
        status: r.status,
        url: norm(r.url),
        count: 0,
        sample: r.responseBodySample ?? '',
    };
    g.count += 1;
    if (!g.sample && r.responseBodySample) g.sample = r.responseBodySample;
    groups.set(key, g);
}

for (const r of [...groups.values()].sort((a, b) => a.action.localeCompare(b.action))) {
    console.log(`[${r.action}] ${r.method} ${r.status} ${r.url} (x${r.count})`);
    if (r.sample) console.log(`    sample: ${r.sample.slice(0, 240).replace(/\s+/g, ' ')}`);
}