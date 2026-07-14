// Render the label-editor view with the sample legacy design into a static
// HTML harness so the editor asset can be exercised in a plain browser.
// Usage: npx vite-node scripts/render-label-harness.mjs <sample.json> <outDir>
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderView } from '../src/templates/liquid';

const [samplePath, outDir] = process.argv.slice(2);
const design = await readFile(samplePath, 'utf8');

const views = {
  async fetch(input) {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    return new Response(await readFile(fileURLToPath(new URL(`../views${url.pathname}`, import.meta.url).href), 'utf8'));
  },
};

const tokens = {
  name: 'Ada Wong 王阿達',
  organization: 'Umbrella Corporation',
  job_title: 'Chief Research Officer',
  checkin_qrcode: 'EAI8:1:M:3883c8',
  prefer_name: '王阿達',
  prefer_company: 'Umbrella',
};

const html = await renderView(views, '/sections/label-editor.liquid', {
  title: 'Sample badge',
  eventName: 'Harness event',
  backHref: '#',
  action: '#',
  deleteAction: '#',
  selfHref: '#',
  labelName: 'Sample badge',
  designJson: design,
  tokensJson: JSON.stringify(tokens),
  hasTokens: true,
  flash: '',
  guestLists: [{ id: 8, name: 'VIP', selected: true }],
  guests: [{ id: 9, name: 'Ada Wong', selected: true }],
  selectedListId: '8',
  selectedGuestId: '9',
});

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Label editor harness</title>
<script src="https://cdn.tailwindcss.com"></script></head><body class="p-4">
${html.replace(/\/admin\/plugins\/events\/assets\//g, './')}
</body></html>`;
await writeFile(`${outDir}/harness.html`, page);
console.log('written', `${outDir}/harness.html`);
