// The Manage labels sheet: rename, merge or remove categories, payment methods and tags.
import { db } from './db.js';
import { normalizeTags, cleanTag, cleanLabel } from './schema.js';
import { LABELS, labelsOf, labelCounts, state, $, esc, toast, sheet, closeSheet } from './core.js';

export let manageKind = 'category';

export function openManage(kind = manageKind) {
  manageKind = kind;
  const meta = LABELS[kind];
  const items = labelCounts(kind);
  const unlabelled = kind === 'tag'
    ? state.entries.filter(e => !e.tags?.length).length
    : state.entries.filter(e => !e[meta.field]).length;

  sheet.innerHTML = `
  <div id="manage">
    <div class="sheet-head">
      <span></span>
      <h2 tabindex="-1" autofocus>Manage labels</h2>
      <button type="button" class="link strong" data-close>Done</button>
    </div>
    <div class="sheet-body">
      <div class="seg">
        ${Object.entries(LABELS).map(([k, m]) =>
          `<button type="button" data-kind="${k}" class="${k === kind ? 'on' : ''}">${m.title}</button>`).join('')}
      </div>
      <p class="fine manage-help">Renaming to a name that already exists <strong>merges</strong> them.
        Deleting only removes the ${meta.noun} — the entries stay.</p>
      ${items.length ? `<section class="card list">${items.map(({ name, n }) => `
        <div class="row static label-row">
          <div class="row-main">
            <div class="row-title">${kind === 'tag' ? '#' : ''}${esc(name)}</div>
            <div class="row-sub">${n} entr${n === 1 ? 'y' : 'ies'}</div>
          </div>
          <button type="button" class="btn small" data-rename="${esc(name)}">Rename</button>
          <button type="button" class="btn small danger" data-remove="${esc(name)}">Delete</button>
        </div>`).join('')}</section>`
      : `<p class="empty-small">No ${meta.title.toLowerCase()} in use yet.</p>`}
      ${unlabelled ? `<p class="fine pad-x">${unlabelled} entr${unlabelled === 1 ? 'y has' : 'ies have'} no ${meta.noun}.</p>` : ''}
    </div>
  </div>`;

  const root = $('#manage');
  root.addEventListener('click', async ev => {
    const t = ev.target;
    if (t.closest('[data-close]')) return closeSheet();
    const k = t.closest('[data-kind]');
    if (k) return openManage(k.dataset.kind);
    const ren = t.closest('[data-rename]');
    const rem = t.closest('[data-remove]');
    if (ren) await renameLabel(kind, ren.dataset.rename);
    else if (rem) await removeLabel(kind, rem.dataset.remove);
  });

  if (!sheet.open) { document.body.classList.add('modal-open'); sheet.showModal(); }
}

/** Replace (or with to === null, remove) a label on every entry that has it. Returns the count changed. */
export async function changeLabel(kind, from, to) {
  const lf = from.toLowerCase();
  const now = new Date().toISOString();
  const changed = [];
  for (const e of state.entries) {
    if (!labelsOf(kind, e).some(l => l.toLowerCase() === lf)) continue;
    const ne = kind === 'tag'
      ? { ...e, tags: normalizeTags(e.tags.map(t => (t.toLowerCase() === lf ? to : t)).filter(Boolean)) }
      : { ...e, [LABELS[kind].field]: to || '' };
    ne.updatedAt = now;
    changed.push(ne);
  }
  if (changed.length) await db.putEntries(changed);
  state.entries = await db.allEntries();
  return changed.length;
}

export async function renameLabel(kind, from) {
  const meta = LABELS[kind];
  const input = prompt(`Rename the ${meta.noun} “${from}” to:`, from);
  if (input == null) return;
  let to = kind === 'tag' ? cleanTag(input) : cleanLabel(input).slice(0, 40);
  if (!to || to === from) return;
  const existing = labelCounts(kind).find(x => x.name.toLowerCase() === to.toLowerCase() && x.name.toLowerCase() !== from.toLowerCase());
  if (existing) {
    if (!confirm(`“${existing.name}” already exists. Merge “${from}” into it?`)) return;
    to = existing.name;
  }
  const n = await changeLabel(kind, from, to);
  toast(existing ? `Merged into “${to}” (${n})` : `Renamed (${n})`);
  openManage(kind);
}

export async function removeLabel(kind, name) {
  const meta = LABELS[kind];
  const n = labelCounts(kind).find(x => x.name === name)?.n || 0;
  if (!confirm(`Remove the ${meta.noun} “${name}” from ${n} entr${n === 1 ? 'y' : 'ies'}? The entries themselves are kept.`)) return;
  await changeLabel(kind, name, null);
  state.tags = state.tags.filter(t => t.toLowerCase() !== name.toLowerCase());
  toast(`Removed from ${n}`);
  openManage(kind);
}
