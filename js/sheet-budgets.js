// The Budgets sheet (Settings → Budgets).
import * as C from './calc.js';
import * as R from './reports.js';
import { cleanTag } from './schema.js';
import { canonicalLabel, categoryOptions, state, $, esc, uid, money, toast, allTags, saveSettings, sheet, closeSheet } from './core.js';

export let editingBudget = null;

/** Expense groups' names, for the Group budget's list. */
const groupNames = () => [...new Set(state.entries.filter(e => e.type === 'expense').map(e => e.name))].sort((a, b) => a.localeCompare(b));
/** What a budget is for: a group budget follows its group's current name. */
export const budgetLabel = b => (b.kind === 'group' && state.entries.find(e => e.id === b.groupId)?.name) || b.label;

/** Open the Budgets sheet with nothing being edited. */
export function manageBudgets() { editingBudget = null; openBudgets(); }

export function openBudgets() {
  const budgets = state.settings.budgets || [];
  const now = new Date();
  const b = editingBudget ? budgets.find(x => x.id === editingBudget) : null;
  const kind = b?.kind || 'category';
  sheet.innerHTML = `
  <div id="budgets">
    <div class="sheet-head"><span></span><h2 tabindex="-1" autofocus>Budgets</h2>
      <button type="button" class="link strong" data-close>Done</button></div>
    <div class="sheet-body">
      <p class="fine manage-help">A monthly limit for a category, a tag or a group. The Overview shows how much of it this month uses,
        and you'll get a warning when a change takes you over.</p>
      ${budgets.length ? `<section class="card list">${budgets.map(x => {
        const s = R.budgetStatus(state.entries, x, now.getFullYear(), now.getMonth());
        return `<div class="row static label-row">
          <div class="row-main"><div class="row-title">${x.kind === 'tag' ? '#' : ''}${esc(budgetLabel(x))}${x.kind === 'group' ? ' <span class="muted">(group)</span>' : ''}</div>
            <div class="row-sub ${s.over ? 'neg' : ''}">${money(x.amount)}/mo · ${money(s.spent)} this month</div></div>
          <button type="button" class="btn small" data-edit-budget="${x.id}">Edit</button>
          <button type="button" class="btn small danger" data-delete-budget="${x.id}">Delete</button>
        </div>`;
      }).join('')}</section>` : ''}

      <div class="group-title">${b ? 'Edit budget' : 'Add a budget'}</div>
      <form id="budgetForm" class="card form" novalidate>
        <div class="field"><span>For</span>
          <div class="seg small grow">
            <label><input type="radio" name="kind" value="category" ${kind === 'category' ? 'checked' : ''}><span>Category</span></label>
            <label><input type="radio" name="kind" value="tag" ${kind === 'tag' ? 'checked' : ''}><span>Tag</span></label>
            <label><input type="radio" name="kind" value="group" ${kind === 'group' ? 'checked' : ''}><span>Group</span></label>
          </div></div>
        <label class="field"><span>Name</span>
          <input name="label" list="dl-budget" placeholder="e.g. Subscriptions" value="${esc(b ? budgetLabel(b) : '')}" autocomplete="off" autocapitalize="none"></label>
        <label class="field"><span>Monthly limit</span>
          <input name="amount" inputmode="decimal" placeholder="0.00" value="${b ? b.amount.toFixed(2) : ''}"></label>
        <datalist id="dl-budget"></datalist>
      </form>
      <p class="form-error" id="budgetError" role="alert"></p>
      <button type="button" class="btn primary" data-save-budget>${b ? 'Save budget' : 'Add budget'}</button>
      ${b ? '<button type="button" class="btn" data-cancel-edit>Cancel editing</button>' : ''}
    </div>
  </div>`;

  const root = $('#budgets');
  const form = $('#budgetForm');
  const syncList = () => {
    const k = form.kind.value;
    const opts = k === 'tag' ? allTags() : k === 'group' ? groupNames() : categoryOptions('expense');
    $('#dl-budget').innerHTML = opts.map(o => `<option value="${esc(o)}">`).join('');
    form.label.placeholder = k === 'tag' ? 'e.g. streaming' : k === 'group' ? 'e.g. Groceries' : 'e.g. Subscriptions';
  };
  syncList();
  form.addEventListener('change', ev => { if (ev.target.name === 'kind') syncList(); });
  form.addEventListener('submit', ev => ev.preventDefault());

  root.addEventListener('click', async ev => {
    const t = ev.target;
    if (t.closest('[data-close]')) { editingBudget = null; return closeSheet(); }
    const ed = t.closest('[data-edit-budget]');
    const del = t.closest('[data-delete-budget]');
    if (ed) { editingBudget = ed.dataset.editBudget; return openBudgets(); }
    if (t.closest('[data-cancel-edit]')) { editingBudget = null; return openBudgets(); }
    if (del) {
      const x = budgets.find(y => y.id === del.dataset.deleteBudget);
      if (!x || !confirm(`Delete the budget for “${x.label}”?`)) return;
      state.settings.budgets = budgets.filter(y => y.id !== x.id);
      await saveSettings();
      toast('Budget deleted');
      return openBudgets();
    }
    if (t.closest('[data-save-budget]')) {
      const k = form.kind.value;
      const label = k === 'tag' ? cleanTag(form.label.value)
        : canonicalLabel(form.label.value, k === 'group' ? groupNames() : categoryOptions('expense'));
      const amount = C.parseAmount(form.amount.value);
      const showErr = m => { $('#budgetError').textContent = m; };
      const group = k === 'group' ? state.entries.find(e => e.type === 'expense' && e.name.toLowerCase() === label.toLowerCase()) : null;
      if (!label) return showErr('Please choose a category, tag or group.');
      if (k === 'group' && !group) return showErr(`There's no group called “${label}”.`);
      if (!(amount > 0)) return showErr('Please enter a monthly limit.');
      const dup = budgets.find(y => y.kind === k && y.id !== editingBudget
        && (group ? y.groupId === group.id : y.label.toLowerCase() === label.toLowerCase()));
      if (dup) return showErr(`There's already a budget for “${budgetLabel(dup)}”.`);
      const rec = { id: editingBudget || uid(), kind: k, label, amount: Math.round(amount * 100) / 100, ...(group ? { groupId: group.id } : {}) };
      state.settings.budgets = editingBudget ? budgets.map(y => (y.id === editingBudget ? rec : y)) : [...budgets, rec];
      editingBudget = null;
      await saveSettings();
      toast('Budget saved');
      openBudgets();
    }
  });

  if (!sheet.open) { document.body.classList.add('modal-open'); sheet.showModal(); }
}
