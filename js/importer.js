// Bank statement import: reading files, the review sheet, applying an import, and undoing imports.
// The pure parts (CSV, matching, payee keys) live in bank.js.
import { db } from './db.js';
import * as C from './calc.js';
import * as Bank from './bank.js';
import * as M from './model.js';
import { normalizeEntry, cleanLabel } from './schema.js';
import { REGION, localDay, state, $, esc, uid, money, dayMonthYear, fmtDate, toast, saveSettings, sheet, closeSheet, newGroup } from './core.js';
import { pickGroup } from './picker.js';
import { reload, render } from './render.js';
import { payeeOfPayment, accountOfPayment } from './sheet-entry.js';

export let imp = null; // the import being reviewed
const NEW_ACCOUNT = '+new'; // the account picker's "New account…"

/**
 * Each import account has catch-all entries, "Everyday spending – <account>" and "Other income –
 * <account>", for transactions that aren't matched to anything. Payees can be moved out of them later.
 */
export const catchKey = (account, type) => `${account.toLowerCase()}|${type}`;
export const catchName = (account, type) => `${type === 'income' ? 'Other income' : 'Everyday spending'} – ${accountName(account)}`;
export const catchEntry = (account, type) => state.entries.find(e => e.catchAll === catchKey(account, type));
export const isCatchAll = e => !!e.catchAll;

/**
 * Import accounts are stored by the name first used for them (their key: it's part of each
 * transaction's id), with a display name that can be renamed safely. See js/model.js.
 */
export const accountKeys = () => M.accountKeys(state.settings);
export const accountName = key => M.accountName(state.settings, key);
export const findAccount = name => M.findAccount(state.settings, name);

/**
 * Where each payee goes, as the importer works with it: { payeeKey: entry id | 'ignore' | 'transfer' },
 * and your names for payees, { payeeKey: name }. Stored on the payees themselves (js/model.js).
 * setRules returns the ids of payees it had to add.
 */
export const getRules = () => M.rulesMap(state.settings);
export const getNames = () => M.namesMap(state.settings);
export function setRules(rules) {
  const { payees, added } = M.applyRules(state.settings, rules, uid);
  state.settings.payees = payees;
  return added;
}
export function setNames(names) {
  const { payees, added } = M.applyNames(state.settings, names, uid);
  state.settings.payees = payees;
  return added;
}

/** Rules that say what a payee *is* rather than which entry it goes to. */
export const isKindRule = v => v === 'ignore' || v === 'transfer';
/**
 * Ignored transactions are kept as { id, date } (older data: just the id). The list is capped, and
 * the oldest *transactions* go first (not the oldest decisions), so re-importing a recent statement
 * never brings back something you ignored. Transfers are kept the same way.
 */
export const IGNORED_MAX = 20000;
export const ignoredId = x => (typeof x === 'string' ? x : x.id);
export const keepNewest = Bank.keepNewest;

export const entryRuleCount = () => M.payeesOf(state.settings).filter(p => p.groupId).length;
export const importedPaymentCount = () => state.entries.reduce((n, e) => n + (e.payments || []).filter(p => p.source).length, 0);

export async function forgetRules() {
  const n = entryRuleCount();
  if (!confirm(`Forget the remembered matches for ${n} payee${n === 1 ? '' : 's'}? Payments already logged stay as they are. Payees you chose to always ignore, or treat as transfers, stay that way.`)) return;
  setRules(Object.fromEntries(Object.entries(getRules()).filter(([, v]) => isKindRule(v))));
  await saveSettings();
  render();
  toast('Remembered matches forgotten');
}

/** Entries that "Add as entry" created during a bank import. */
export const createdByImport = e => !!e.fromImport || /^Added from a bank import/.test(e.notes || '');
export const hasImportData = () => importedPaymentCount() > 0 || entryRuleCount() > 0
  || (state.settings.ignoredTxns || []).length > 0 || (state.settings.transfers || []).length > 0
  || state.entries.some(createdByImport);

/**
 * "Undo bank imports": shows what imports left behind and removes it, so statements can be
 * imported again from scratch. Entries an import created are listed so you can keep the good ones.
 */
export function openUndoImports() {
  const created = state.entries.filter(createdByImport).sort((a, b) => a.name.localeCompare(b.name));
  const pays = importedPaymentCount();
  const rules = entryRuleCount();
  const ignored = (state.settings.ignoredTxns || []).length + (state.settings.transfers || []).length;
  const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  sheet.innerHTML = `
  <form id="undoImports" method="dialog">
    <div class="sheet-head">
      <button type="button" class="link" data-close>Cancel</button>
      <h2 tabindex="-1" autofocus>Undo bank imports</h2>
      <span></span>
    </div>
    <div class="sheet-body">
      <p class="fine pad-x">Removes what bank imports added, so you can import your statements again from scratch.
        Export a backup first if you might want it back.</p>
      <section class="card form">
        <label class="field toggle"><span>Remove ${n(pays, 'imported payment')}</span>
          <input type="checkbox" name="payments" ${pays ? 'checked' : 'disabled'}></label>
        <label class="field toggle"><span>Forget ${n(rules, 'remembered match', 'remembered matches')}</span>
          <input type="checkbox" name="rules" ${rules ? 'checked' : 'disabled'}></label>
        <label class="field toggle"><span>Show ${n(ignored, 'ignored transaction or transfer', 'ignored transactions and transfers')} again</span>
          <input type="checkbox" name="ignored" ${ignored ? 'checked' : 'disabled'}></label>
      </section>
      ${created.length ? `<div class="group-title">Payee groups added by imports (${created.length}) — switch off any to keep</div>
      <section class="card form">${created.map(e => `
        <label class="field toggle"><span>${esc(e.name)}<br><span class="muted small-text">${esc(C.FREQ[e.frequency]?.label || '')} · from ${esc(fmtDate(e.startDate))}</span></span>
          <input type="checkbox" name="del" value="${esc(e.id)}" checked></label>`).join('')}
      </section>` : ''}
      <p class="fine pad-x">Kept: payments you logged yourself, your other payee groups, your names for payees, account names
        and payees you chose to always ignore or treat as transfers.</p>
      <button type="button" class="btn primary danger-fill" data-undo>Undo imports</button>
    </div>
  </form>`;
  const form = $('#undoImports');
  form.addEventListener('click', async ev => {
    if (ev.target.closest('[data-close]')) return closeSheet();
    if (!ev.target.closest('[data-undo]')) return;
    const del = new Set([...form.querySelectorAll('[name=del]:checked')].map(x => x.value));
    const what = [
      form.payments.checked && n(pays, 'payment'),
      del.size && n(del.size, 'payee group'),
    ].filter(Boolean);
    if (what.length && !confirm(`Delete ${what.join(' and ')}? This can't be undone.`)) return;
    const now = new Date().toISOString();
    if (form.payments.checked) {
      const changed = state.entries.filter(e => !del.has(e.id) && (e.payments || []).some(p => p.source)).map(e => ({
        ...e, updatedAt: now,
        // A payment you logged yourself and an import then matched goes back to being yours.
        payments: e.payments.filter(p => !p.source || p.handLogged).map(p => {
          if (!p.source) return p;
          const { source, handLogged, account, ...mine } = p;
          return mine;
        }),
      }));
      if (changed.length) await db.putEntries(changed);
    }
    for (const id of del) await db.deleteEntry(id);
    const keptRules = Object.entries(getRules())
      .filter(([, v]) => (form.rules.checked ? isKindRule(v) : !del.has(v)));
    setRules(Object.fromEntries(keptRules));
    // Payees only imports knew about (no name, no rule, no payments left) go too
    if (form.payments.checked) {
      const used = new Set(state.entries.filter(e => !del.has(e.id)).flatMap(e => (e.payments || []).filter(p => !p.source || p.handLogged).map(p => p.payee)));
      state.settings.payees = M.payeesOf(state.settings).filter(p => p.name || p.rule || p.groupId || p.keys.some(k => used.has(k)));
    }
    if (form.ignored.checked) { state.settings.ignoredTxns = []; state.settings.transfers = []; }
    state.settings.importLog = []; // nothing left for "Undo last import" to undo
    await saveSettings();
    closeSheet();
    await reload();
    toast('Bank imports undone');
  });
  if (!sheet.open) { document.body.classList.add('modal-open'); sheet.showModal(); }
}

/**
 * "Undo last import": takes back the most recent import only. Its payments come out (wherever
 * they've been moved since), payments you'd logged yourself go back to how they were, transfers it
 * took out of a catch-all (or a payee's entry) go back in, entries it added are deleted unless something else has been
 * logged on them, and its ignored transactions, transfers, remembered payees and balance are undone.
 * Can be repeated, back through the last few imports.
 */
export async function undoLastImport() {
  const log = state.settings.importLog || [];
  const b = log.at(-1);
  if (!b) return;
  const pays = state.entries.reduce((n, e) => n + (e.payments || []).filter(p => p.batch === b.id).length, 0);
  const created = state.entries.filter(e => e.importBatch === b.id);
  const parts = [`${pays} payment${pays === 1 ? '' : 's'}`];
  if (created.length) parts.push(`the ${created.length} payee group${created.length === 1 ? '' : 's'} it added (${created.map(e => e.name).join(', ')})`);
  if (!confirm(`Undo the import of “${b.file}” into ${(b.accounts || [b.account]).map(accountName).join(' and ')} on ${fmtDate(localDay(b.at))}? This removes ${parts.join(' and ')}. Payments you logged yourself go back to how they were.`)) return;

  const now = new Date().toISOString();
  const restore = new Map(b.linked.filter(Boolean).map(p => [p.id, p]));
  const changed = new Map();
  for (const e of state.entries) {
    const before = e.payments || [];
    let after = before.filter(p => p.batch !== b.id).map(p => restore.get(p.id) || p);
    for (const x of b.takenOut) if (x.entryId === e.id && x.payment && !after.some(p => p.id === x.payment.id)) after = [...after, x.payment];
    if (after.length !== before.length || after.some((p, i) => p !== before[i])) changed.set(e.id, { ...e, payments: after, updatedAt: now });
  }
  // Entries it added go, unless you've logged something else on them since
  const del = created.filter(e => !(changed.get(e.id) || e).payments.length);
  const kept = created.length - del.length;
  for (const e of del) changed.delete(e.id);
  // Entries it removed because their only payment was a transfer come back, as they were
  for (const e of b.removedEntries || []) if (!state.entries.some(o => o.id === e.id)) changed.set(e.id, e);
  const toSave = [...changed.values()].map(normalizeEntry).filter(Boolean);
  if (toSave.length) await db.putEntries(toSave);
  for (const e of del) await db.deleteEntry(e.id);

  const gone = new Set(del.map(e => e.id));
  const rules = getRules();
  for (const [k, { before, after }] of Object.entries(b.rules || {})) {
    if ((rules[k] ?? null) !== after) continue; // changed again since: leave it
    if (before == null) delete rules[k]; else rules[k] = before;
  }
  for (const [k, v] of Object.entries(rules)) if (gone.has(v)) delete rules[k];
  setRules(rules);
  // Payees this import added go, unless you've named them, or put them somewhere, since
  const addedPayees = new Set(b.payees || []);
  state.settings.payees = M.payeesOf(state.settings).filter(p => !addedPayees.has(p.id) || p.name || p.rule || p.groupId);
  // …and so do accounts it added, unless something else has come in through them
  const stillUsed = new Set(state.entries.flatMap(e => (e.payments || []).filter(p => p.batch !== b.id).map(p => String(p.account || '').toLowerCase())));
  const addedAccounts = new Set((b.newAccounts || []).map(k => k.toLowerCase()));
  state.settings.accounts = M.accountsOf(state.settings).filter(a => !addedAccounts.has(a.key.toLowerCase()) || stillUsed.has(a.key.toLowerCase()));
  for (const { key, before } of b.accountBalances || []) state.settings.accounts = M.updateAccount(state.settings, key, { balance: before || undefined });
  const ign = new Set(b.ignored), tr = new Set(b.transfers);
  state.settings.ignoredTxns = (state.settings.ignoredTxns || []).filter(x => !ign.has(ignoredId(x)));
  state.settings.transfers = (state.settings.transfers || []).filter(x => !tr.has(x.id));
  const bal = state.settings.balance;
  if (b.balance && bal?.account === (b.balance.account ?? b.account)) state.settings.balance = b.balance.before;
  state.settings.importLog = log.slice(0, -1);
  await saveSettings();
  await reload();
  toast(`Import undone${kept ? ` · kept ${kept} payee group${kept === 1 ? '' : 's'} with other payments` : ''}`);
}

/** Give a payee your own name, used on the import screen, for matching and in payment notes. */
export async function renamePayee(keys) {
  keys = [].concat(keys); // a row on the import screen can stand for several payees with the same name
  const key = keys[0];
  const names = getNames();
  const sample = imp?.txns.find(t => t.payee === key);
  const current = names[key] || (sample?.oldPayee && names[sample.oldPayee]) || '';
  const input = prompt(`Your name for “${sample?.description || key}”. It's used for this payee from now on. Give two payees the same name to put them together. Leave blank to use the bank's text.`,
    current || Bank.payeeName(key));
  if (input == null) return;
  const name = cleanLabel(input);
  for (const k of keys) {
    const s = imp?.txns.find(t => t.payee === k);
    if (s?.oldPayee) delete names[s.oldPayee];
    if (name) names[k] = name; else delete names[k];
  }
  setNames(names);
  await saveSettings();
  toast(name ? `Named “${name}”` : 'Name removed');
}

export async function renameAccount(key) {
  const from = accountName(key);
  const input = prompt(`Rename the account “${from}” to:`, from);
  if (input == null) return;
  const to = cleanLabel(input);
  if (!to || to === from) return;
  const clash = findAccount(to);
  if (clash && clash !== key) { alert(`There's already an account called “${accountName(clash)}”.`); return; }
  state.settings.accounts = M.updateAccount(state.settings, key, { name: to });
  // Entries added from an import use the account as their payment method; keep those in step.
  const now = new Date().toISOString();
  // …and the account's catch-all entries keep its name in theirs.
  const isCatchOf = e => e.catchAll && e.catchAll.startsWith(`${key.toLowerCase()}|`);
  const changed = state.entries.filter(e => (e.method || '').toLowerCase() === from.toLowerCase() || isCatchOf(e))
    .map(e => ({ ...e, method: (e.method || '').toLowerCase() === from.toLowerCase() ? to : e.method,
      name: isCatchOf(e) ? catchName(key, e.catchAll.split('|').at(-1)) : e.name, updatedAt: now }));
  if (changed.length) await db.putEntries(changed);
  await saveSettings();
  await reload();
  toast(changed.length ? `Renamed · ${changed.length} payee group${changed.length === 1 ? '' : 's'} updated` : 'Account renamed');
}

/** Transaction ids already dealt with: imported as payments, ignored, or marked as transfers. */
export function knownIds() {
  return new Set([
    ...state.entries.flatMap(e => (e.payments || []).map(p => p.source).filter(Boolean)),
    ...(state.settings.ignoredTxns || []).map(ignoredId),
    ...(state.settings.transfers || []).map(x => x.id),
  ]);
}

/**
 * One or more statement files, reviewed together. Each file has its own account, date order and
 * sign, and is checked against its own Balance column. Choosing several at once lets transfers
 * between them be paired up (both sides are in the same import).
 */
export async function startBankImport(fileList) {
  const files = [], bad = [];
  for (const file of fileList) {
    let text;
    try { text = await file.text(); } catch { bad.push(file.name); continue; }
    const rows = Bank.parseCSV(text);
    const fmt = Bank.detectFormat(rows);
    if (!fmt) { bad.push(file.name); continue; }
    const detected = Bank.detectDateOrder(rows.slice(fmt.hasHeader ? 1 : 0).map(r => r[fmt.date]));
    const order = detected || (REGION === 'US' ? 'MDY' : 'DMY');
    // The Balance column, if there is one, checks the amounts were read the right way round
    const asRead = Bank.toTransactions(rows, fmt, order);
    const check = Bank.checkBalances(asRead);
    const autoFlip = !!check && !Bank.balancesAgree(check.normal, check.pairs) && Bank.balancesAgree(check.flipped, check.pairs);
    if (autoFlip) fmt.flip = true;
    const txns = autoFlip ? Bank.toTransactions(rows, fmt, order) : asRead;
    const dates = txns.map(t => t.date).sort();
    files.push({ fileName: file.name, rows, fmt, order, orderDetected: !!detected, check, autoFlip, txns,
      guess: `${fmt.bank} ${fmt.kind === 'card' ? 'credit card' : 'account'}`,
      span: dates.length ? [dates[0], dates.at(-1)] : null });
  }
  if (bad.length) {
    const need = 'It needs a date, an amount and a description in each row (CommBank CSVs work as they are).';
    alert(fileList.length === 1 ? `This file wasn’t recognised as a bank statement. ${need}`
      : `${bad.map(n => `“${n}”`).join(', ')} ${bad.length === 1 ? 'wasn’t' : 'weren’t'} recognised as a bank statement${files.length ? ' and will be left out' : ''}. ${need}`);
  }
  if (!files.length) return;

  // Which account each file is from is only assumed when its transactions were imported into one
  // before; otherwise you choose one, or name a new one. Until then the file works under the name
  // suggested from its bank (two new files of the same kind over the same dates under two names), so
  // the review can be shown, but nothing imports until every file has an account.
  const known = knownIds();
  for (const F of files) {
    const seen = accountKeys().find(k => Bank.withIds(F.txns, k).some(t => known.has(t.id)));
    F.account = seen || unusedName(F, files);
    F.chosen = !!seen;
    F.newAccount = !seen && !accountKeys().length; // no accounts yet: just a name box
    delete F.txns;
  }
  imp = { files, newGroups: new Set(), named: new Map() };
  // "Balance now" is one number, so at most one file sets it: the newest of those that would
  files.forEach(F => { F.useBalance = balanceByDefault(F); });
  const setters = files.filter(F => F.useBalance).sort((a, b) => b.check.latest.date.localeCompare(a.check.latest.date));
  setters.slice(1).forEach(F => { F.useBalance = false; });
  buildImport();
  openImport();
}

/** A name for a file's account that isn't an account yet, nor another file's over the same dates. */
function unusedName(F, files) {
  const overlaps = (a, b) => a.span && b.span && a.span[0] <= b.span[1] && b.span[0] <= a.span[1];
  let name = F.guess, n = 1;
  while (findAccount(name) || files.some(G => G !== F && G.account?.toLowerCase() === name.toLowerCase() && overlaps(F, G))) {
    name = `${F.guess} ${++n}`;
  }
  return name;
}

/** (Re)work out transactions, duplicates, suggestions and recurring groups for the current settings. */
export function buildImport() {
  const known = knownIds();
  const taken = new Set(); // the same transaction in two overlapping files counts once
  const fresh = [];
  imp.files.forEach((F, i) => {
    const all = Bank.withIds(Bank.toTransactions(F.rows, F.fmt, F.order), F.account).map(t => ({ ...t, account: F.account, file: i }));
    const mine = all.filter(t => !known.has(t.id) && !taken.has(t.id));
    mine.forEach(t => taken.add(t.id));
    fresh.push(...mine);
    F.total = all.length;
    F.already = all.length - mine.length;
    const dates = all.map(t => t.date).sort();
    F.range = dates.length ? [dates[0], dates.at(-1)] : null;
  });
  const live = state.entries.filter(e => !isCatchAll(e) && !C.isEnded(e, C.addDaysISO(C.todayISO(), -90)));
  let txns = Bank.suggest(fresh, live, getRules(), getNames());
  // A payee like one you've already put in a group (the same company paid another way, or from
  // another account) is suggested for that group
  txns = Bank.suggestSimilar(txns, knownGrouped(live));
  // Money moving between your own accounts isn't spending or income. The other side can be in an
  // earlier import, or in another file of this one.
  const open = txns.filter(t => !t.action).map(t => ({ id: t.id, account: t.account, date: t.date, amount: t.amount, kind: 'batch' }));
  txns = Bank.suggestTransfers(txns, [...transferPool(), ...open]);
  // Refunds go back to where that payee's purchases go
  const { toEntry, toCatch } = spendingHistory(live);
  txns = Bank.suggestRefunds(txns, toEntry);
  imp.txns = txns.sort((a, b) => b.date.localeCompare(a.date));
  // Everything imports unless you say otherwise: matches go to their entry, payees that look
  // recurring get a recurring entry, and every other payee an entry of its own. Very similar
  // payees (the same shop in two towns) share one.
  imp.recurring = Bank.findRecurring(imp.txns.filter(t => !t.action));
  const counts = new Map();
  for (const t of imp.txns) if (!t.action) {
    const c = counts.get(t.payee) || { key: t.payee, name: t.name || Bank.payeeName(t.payee), count: 0 };
    c.count++;
    counts.set(t.payee, c);
  }
  imp.cluster = Bank.clusterPayees([...counts.values()]);
  imp.clusterName = new Map();
  for (const lead of new Set(imp.cluster.values())) {
    const members = [...counts.values()].filter(c => imp.cluster.get(c.key) === lead).sort((a, b) => b.count - a.count);
    const own = members.find(c => c.key === lead);
    // Your own name for a payee wins; otherwise what their names have in common
    imp.clusterName.set(lead, own.name !== Bank.payeeName(lead) ? own.name : Bank.commonName(members.map(c => c.name)));
  }
  imp.offGroups ||= new Set(); // recurring groups you switched off
  imp.newGroups = new Set(imp.recurring.map(g => g.key).filter(k => !imp.offGroups.has(k)));
  const groupOf = new Map(imp.recurring.flatMap(g => g.txns.map(t => [t.id, g.key])));
  // A refund from a payee you also spend with (in this import, or into a catch-all before) follows
  // their purchases rather than counting as income.
  const spentWith = new Map();
  for (const t of imp.txns) if (t.amount < 0 && !t.action && !spentWith.has(t.payee)) spentWith.set(t.payee, t);
  const byDefault = t => {
    if (t.action) return t.action;
    if (t.amount > 0 && spentWith.has(t.payee)) return byDefault(spentWith.get(t.payee));
    if (t.amount > 0 && toCatch.has(t.payee)) return 'catch:expense';
    return imp.newGroups.has(groupOf.get(t.id)) ? `new:${groupOf.get(t.id)}` : ownEntry(t);
  };
  // Keep choices the user made by hand when this is a redraw (e.g. after renaming a payee).
  const prev = imp.decision, prevSuggested = imp.suggested;
  imp.suggested = new Map(imp.txns.map(t => [t.id, byDefault(t)]));
  imp.decision = new Map(imp.txns.map(t => [t.id,
    prev?.has(t.id) && prev.get(t.id) !== prevSuggested.get(t.id) ? prev.get(t.id) : imp.suggested.get(t.id)]));
  imp.links = new Map();
  for (const [id, d] of imp.decision) if (d.startsWith('new:') && !imp.newGroups.has(d.slice(4))) imp.decision.set(id, imp.suggested.get(id));
}

/**
 * A category for a new group: the one a very similar payee's group has ("Kmart Sydney" → the group
 * "Kmart Bondi" is in), else that of a group with a very similar name, else one from a well-known
 * name in it or its payee keys (Woolworths → Groceries), else none.
 */
export function suggestCategory(name, type, keys = []) {
  for (const p of M.payeesOf(state.settings)) {
    const e = p.groupId && state.entries.find(x => x.id === p.groupId);
    if (e?.category && e.type === type && Bank.similarPayees(name, M.payeeTitle(p))) return e.category;
  }
  return state.entries.find(x => x.category && x.type === type && Bank.similarPayees(name, x.name))?.category
    || (type === 'expense' ? Bank.keywordCategory(name, ...keys) : '');
}

/**
 * Groups to offer first for a payee called `name`: the groups of very similar payees (the same
 * company under another spelling), then groups with a very similar name. Up to 3 ids.
 */
export function groupSuggestions(name, type, exclude = []) {
  const out = [];
  const add = id => { if (id && !exclude.includes(id) && !out.includes(id)) out.push(id); };
  const byId = new Map(state.entries.map(e => [e.id, e]));
  for (const p of M.payeesOf(state.settings)) {
    const e = byId.get(p.groupId);
    if (e && (e.type === type || type === 'income') && Bank.similarPayees(name, M.payeeTitle(p))) add(e.id);
  }
  for (const e of state.entries) if (e.type === type && Bank.similarPayees(name, e.name)) add(e.id);
  return out.slice(0, 3);
}

/** Payees already in a group that's still running, for suggestSimilar: [{ key, name, groupId, type }]. */
export function knownGrouped(live) {
  const byId = new Map(live.map(e => [e.id, e]));
  return M.payeesOf(state.settings).filter(p => byId.has(p.groupId))
    .flatMap(p => p.keys.map(key => ({ key, name: M.payeeTitle(p), groupId: p.groupId, type: byId.get(p.groupId).type })));
}

/**
 * The other side of possible transfers, from your other accounts: transactions already marked as
 * transfers, and ones imported into an account's catch-all entry (a card payment that went to
 * "Everyday spending" before the card's own statement was imported). Amounts use the bank's sign.
 */
export function transferPool() {
  const out = (state.settings.transfers || []).map(x => ({ ...x, kind: 'transfer' }));
  for (const e of state.entries) {
    // A catch-all, or a payee's own entry an import added (no set schedule): where a transfer
    // ends up when its other side hasn't been imported yet
    if (!e.catchAll && !(e.fromImport && C.isIrregular(e))) continue;
    for (const p of e.payments || []) {
      const account = p.source && accountOfPayment(p, e);
      if (!account || account === 'unknown') continue;
      out.push({ id: p.source, account: account.toLowerCase(), date: p.date, amount: e.type === 'expense' ? -p.amount : p.amount,
        kind: 'payment', entryId: e.id, paymentId: p.id });
    }
  }
  return out;
}

/** Where each payee's imported purchases went before: toEntry (payee → entry id) and toCatch (a catch-all). */
export function spendingHistory(live) {
  const ids = new Set(live.map(e => e.id));
  const toEntry = new Map(), toCatch = new Set(), when = new Map();
  for (const e of state.entries) {
    if (e.type !== 'expense') continue;
    for (const p of e.payments || []) {
      const k = payeeOfPayment(p);
      if (!k || p.amount <= 0) continue;
      if (isCatchAll(e)) { toCatch.add(k); continue; }
      if (ids.has(e.id) && !(when.get(k) > p.date)) { toEntry.set(k, e.id); when.set(k, p.date); }
    }
  }
  return { toEntry, toCatch };
}

/** An account as stored with a transfer (lowercase) → its display name. */
export const accountLabel = acc => accountName(accountKeys().find(k => k.toLowerCase() === String(acc).toLowerCase()) || acc);

/** The new entry of its own a payee goes to: shared with very similar payees in this import. */
export const ownEntry = t => `make:${imp.cluster?.get(t.payee) || t.payee}`;
/** The name that new entry gets. */
export const makeName = (key, t) => imp.clusterName?.get(key) || t?.name || Bank.payeeName(key);

/** Choices that don't log a payment. */
export const quiet = d => !!d && (d.startsWith('ignore') || d === 'transfer');

/** Whether a file's Balance column adds up with its amounts, for its current sign setting. */
export const balanceOK = F => !!F.check && Bank.balancesAgree(F.fmt.flip ? F.check.flipped : F.check.normal, F.check.pairs);

/**
 * Whether a file sets "Balance now" unless you say otherwise: when there's no balance yet, or the
 * last one came from this account's statement and this one is as new or newer. A balance you typed
 * yourself is left alone.
 */
export function balanceByDefault(F) {
  if (!F.check) return false;
  const bal = state.settings.balance;
  if (!bal) return true;
  return !!bal.account && bal.account.toLowerCase() === F.account.toLowerCase() && F.check.latest.date >= bal.date;
}

/** Which transactions update a payment the user already logged by hand (for the current choices). */
export const importLinks = () => Bank.planLinks(imp.txns, imp.decision, new Map(state.entries.map(e => [e.id, e])));

/** Matched rows beyond this many are folded away: they're already going to their entries. */
export const MATCHED_OPEN = 8;

export function openImport() {
  imp.links = importLinks();
  const many = imp.files.length > 1;
  const entriesBy = type => state.entries.filter(e => e.type === type && !isCatchAll(e)).sort((a, b) => a.name.localeCompare(b.name));
  const groupOf = new Map(imp.recurring.flatMap(g => g.txns.map(t => [t.id, g])));
  const accounts = [...new Set(imp.files.map(F => F.account))];

  // New entries this import will add, so other payees can be put in with them
  const txById = new Map(imp.txns.map(t => [t.id, t]));
  const pending = new Map();
  for (const [id, v] of imp.decision) {
    if (pending.has(v)) continue;
    const t = txById.get(id);
    if (v.startsWith('new:')) {
      const g = imp.recurring.find(x => x.key === v.slice(4));
      if (g) pending.set(v, { label: `${g.name} (${C.FREQ[g.frequency].label.toLowerCase()})`, out: g.type === 'expense' });
    } else if (v.startsWith('make:')) {
      const of = imp.txns.filter(x => x.payee === v.slice(5));
      const lead = of.find(x => x.amount < 0) || of[0] || t;
      pending.set(v, { label: makeName(v.slice(5), lead), out: lead.amount < 0 });
    } else if (v.startsWith('named:')) {
      pending.set(v, { label: `${v.slice(6)} (new payee group)`, out: imp.named.get(v.slice(6)) !== 'income' });
    }
  }

  // `d` is the current choice (null when the transactions in a row differ). `ts` are the
  // transactions the choice covers, so the catch-all can be named for their account.
  const select = (t, { attr = `data-txn="${t.id}"`, d = imp.decision.get(t.id) || '', ts = [t], label = 'What is this?' } = {}) => {
    const g = groupOf.get(t.id);
    const opt = (v, text) => `<option value="${esc(v)}" ${d === v ? 'selected' : ''}>${esc(text)}</option>`;
    const list = type => entriesBy(type).map(e => opt(e.id, e.name)).join('')
      || '<option disabled>No payee groups yet</option>';
    // A new entry for this payee: the recurring one spotted, else one with no set schedule (or a
    // one-off if it's the only transaction from them)
    // A recurring payee can also go to an entry of its own with no set schedule
    const plain = ownEntry(t);
    const make = (g ? opt(`new:${g.key}`, `+ New payee group: ${g.name} (${C.FREQ[g.frequency].label.toLowerCase()})`) : '')
      + opt(plain, `+ New payee group: ${makeName(plain.slice(5), t)}${g ? ' (no set schedule)' : ''}`);
    const others = [...pending].filter(([v, p]) => v !== plain && v !== `new:${g?.key}` && (p.out === t.amount < 0 || v === d));
    const type = t.amount < 0 ? 'expense' : 'income';
    const accs = new Set(ts.map(x => x.account.toLowerCase()));
    const catchLabel = accs.size > 1 ? `${type === 'income' ? 'Other income' : 'Everyday spending'} (each account’s own)` : catchName(t.account, type);
    return `<select ${attr} aria-label="${esc(label)}">
      ${d == null ? '<option value="mixed" selected disabled>Mixed — choose one for all</option>' : ''}
      ${opt('', 'Skip for now')}
      ${opt('ignore', ts.length > 1 ? 'Ignore these' : 'Ignore this one')}
      ${opt('ignore-payee', 'Always ignore this payee')}
      ${opt('transfer', 'Transfer between my accounts')}
      ${opt(`catch:${type}`, catchLabel)}
      ${make}
      <option value="pick">Choose a payee group or type a name…</option>
      ${others.length ? `<optgroup label="New in this import">${others.map(([v, p]) => opt(v, p.label)).join('')}</optgroup>` : ''}
      <optgroup label="${t.amount < 0 ? 'Expenses' : 'Income'}">${list(type)}</optgroup>
      <optgroup label="${t.amount < 0 ? 'Income (as a refund)' : 'Expenses (as a refund)'}">${list(t.amount < 0 ? 'income' : 'expense')}</optgroup>
    </select>`;
  };
  // Why a transaction is suggested where it is (only while that's still the choice)
  const whyPill = t => {
    if (t.why === 'rule') return '<span class="pill">remembered</span>';
    if ((imp.decision.get(t.id) || '') !== t.action) return '';
    if (t.why === 'match') return `<span class="pill ${t.on.length === 3 ? 'good' : 'soon'}" title="Matched on ${t.on.join(', ')}">${t.on.join(' · ')}</span>`;
    if (t.why === 'transfer-pair') return `<span class="pill good" title="The same amount the other way in ${esc(accountLabel(t.pair.account))}">↔ ${esc(accountLabel(t.pair.account))} ${esc(fmtDate(t.pair.date))}</span>`;
    if (t.why === 'transfer-text') return '<span class="pill soon">looks like a transfer</span>';
    if (t.why === 'refund') return '<span class="pill">refund</span>';
    if (t.why === 'similar') return `<span class="pill" title="Like ${esc(t.like)}, already in this group">like ${esc(t.like)}</span>`;
    return '';
  };
  const acctTag = t => (many && accounts.length > 1 ? `<span class="imp-acct">${esc(accountName(t.account))}</span>` : '');
  const txRow = t => {
    const d = imp.decision.get(t.id) || '';
    const link = imp.links.get(t.id);
    const tag = (link ? `<span class="pill">already logged${link.date !== t.date ? ` ${esc(fmtDate(link.date))}` : ''}</span>` : '') + whyPill(t);
    return `<div class="imp-row ${d && !quiet(d) ? 'chosen' : ''} ${quiet(d) ? 'ignored' : ''}">
      <div class="imp-top">
        <span class="imp-date">${esc(fmtDate(t.date))}</span>
        <span class="imp-desc">${acctTag(t)}${t.name ? `<span class="imp-name">${esc(t.name)}</span><span class="imp-raw">${esc(t.description)}</span>` : esc(t.description)}</span>
        <span class="imp-amt ${t.amount < 0 ? 'neg' : 'pos'}">${t.amount < 0 ? '−' : '+'}${money(Math.abs(t.amount))}</span>
      </div>
      <div class="imp-bottom"><button type="button" class="link imp-rename" data-rename-payee="${esc(t.payee)}"
        aria-label="Rename ${esc(t.name || t.description)}">${t.name ? 'Rename' : 'Name'}</button>${tag}${select(t)}</div>
    </div>`;
  };
  const transfers = imp.txns.filter(t => t.action === 'transfer');
  const suggested = imp.txns.filter(t => t.action && t.action !== 'transfer');
  const rest = imp.txns.filter(t => !t.action);
  const chosen = [...imp.decision.values()].filter(v => v && !quiet(v)).length;
  const takesOut = transfers.some(t => t.pair?.kind === 'payment');

  // One row per payee (payees you've given the same name share a row): one choice covers all of
  // them. Unmatched ones are grouped by payee; matched ones by payee and the entry they're going to.
  imp.pgroups = new Map();
  const group = (list, keyOf) => {
    const out = new Map();
    for (const t of list) {
      const name = t.name || Bank.payeeName(t.payee);
      const key = keyOf(t, name.toLowerCase());
      if (!out.has(key)) out.set(key, { key, name, named: !!t.name, txns: [], payees: [] });
      const pg = out.get(key);
      pg.txns.push(t);
      if (!pg.payees.includes(t.payee)) pg.payees.push(t.payee);
    }
    out.forEach((v, k) => imp.pgroups.set(k, v));
    return [...out.values()].sort((a, b) => b.txns.length - a.txns.length || a.name.localeCompare(b.name));
  };
  // Very similar payees (and money out and back from one payee) share a row, like they share an entry
  const payeeList = group(rest, t => `c:${imp.cluster.get(t.payee) || t.payee}`);
  for (const pg of payeeList) {
    pg.name = makeName(pg.key.slice(2), pg.txns[0]);
  }
  const matchedList = group(suggested, (t, name) => `m:${t.action}|${name}`);
  imp.openGroups ||= new Set();
  const payeeRow = pg => {
    const ts = pg.txns, t0 = ts[0], one = ts.length === 1;
    const lead = ts.find(t => t.amount < 0) || t0; // the choices offered are for their purchases
    const ds = new Set(ts.map(t => imp.decision.get(t.id) || ''));
    const d = ds.size === 1 ? [...ds][0] : null;
    const total = ts.reduce((s, t) => s + t.amount, 0);
    const raws = [...new Set(ts.map(t => t.description))];
    const showName = pg.named || !one;
    const linked = ts.filter(t => imp.links.get(t.id)).length;
    const pills = [...new Set(ts.map(whyPill).filter(Boolean))].join('');
    const amt = (a, cls = '') => `<span class="imp-amt ${cls} ${a < 0 ? 'neg' : 'pos'}">${a < 0 ? '−' : '+'}${money(Math.abs(a))}</span>`;
    return `<div class="imp-row imp-payee ${d && !quiet(d) ? 'chosen' : ''} ${quiet(d) ? 'ignored' : ''}">
      <div class="imp-top">
        <span class="imp-date">${one ? esc(fmtDate(t0.date)) : `${ts.length} ×`}</span>
        <span class="imp-desc">${[...new Set(ts.map(acctTag))].join('')}${showName ? `<span class="imp-name">${esc(pg.name)}</span><span class="imp-raw">${esc(raws[0])}${raws.length > 1 ? ` + ${raws.length - 1} more` : ''}</span>` : esc(t0.description)}</span>
        ${amt(total)}
      </div>
      <div class="imp-bottom"><button type="button" class="link imp-rename" data-rename-group="${esc(pg.key)}"
        aria-label="Rename ${esc(showName ? pg.name : t0.description)}">${pg.named ? 'Rename' : 'Name'}</button>${linked ? `<span class="pill">${linked} already logged</span>` : ''}${pills}${select(lead, {
        attr: `data-pgroup="${esc(pg.key)}"`, d, ts, label: `What is ${showName ? pg.name : t0.description}?` })}</div>
      ${one ? '' : `<details class="imp-list" data-pg="${esc(pg.key)}" ${imp.openGroups.has(pg.key) ? 'open' : ''}>
        <summary>${ts.length} transactions · ${esc(fmtDate(ts.at(-1).date))} – ${esc(fmtDate(t0.date))}</summary>
        ${ts.map(t => `<div class="imp-sub"><span class="imp-date">${esc(fmtDate(t.date))}</span>
          <span class="imp-sub-desc">${esc(t.description)}</span>${amt(t.amount)}</div>`).join('')}
      </details>`}
    </div>`;
  };
  // A single matched transaction keeps its own row (with the exact signals); several from one payee share one
  const matchedRow = pg => (pg.txns.length === 1 ? txRow(pg.txns[0]) : payeeRow(pg));
  const matchedChanged = suggested.some(t => (imp.decision.get(t.id) || '') !== t.action);
  const matchedOpen = matchedList.length <= MATCHED_OPEN || imp.openGroups.has('__matched') || matchedChanged;
  const matchedEntries = new Set(suggested.filter(t => !quiet(t.action)).map(t => t.action)).size;

  // Per file: where it goes, how to read it, and whether it adds up
  const fileCard = (F, i) => {
    const sfx = i ? `-${i}` : '';
    const sample = F.rows[F.fmt.hasHeader ? 1 : 0]?.[F.fmt.date] || '';
    const sampleISO = Bank.parseDate(sample, F.order);
    const ok = balanceOK(F);
    const agree = F.check ? (F.fmt.flip ? F.check.flipped : F.check.normal) : 0;
    const other = F.check ? (F.fmt.flip ? F.check.normal : F.check.flipped) : 0;
    return `<section class="card form imp-filecard" data-file="${i}">
        <div class="field"><span>File</span><div class="imp-file">${esc(F.fileName)}<br><span class="muted">${F.total} transactions${F.range ? ` · ${fmtDate(F.range[0])} – ${fmtDate(F.range[1])}` : ''}</span></div></div>
        ${accountKeys().length ? `<label class="field"><span>Account</span>
          <select id="impAccountPick${sfx}" data-account-pick="${i}" data-guess="${esc(F.guess)}" aria-label="Account${many ? ` for ${esc(F.fileName)}` : ''}">
            ${!F.chosen && !F.newAccount ? '<option value="" selected disabled>Choose an account…</option>' : ''}
            ${accountKeys().map(k => `<option value="${esc(k)}" ${F.chosen && !F.newAccount && k === F.account ? 'selected' : ''}>${esc(accountName(k))}</option>`).join('')}
            <option value="${NEW_ACCOUNT}" ${F.newAccount ? 'selected' : ''}>New account…</option>
          </select></label>` : ''}
        ${F.newAccount ? `<label class="field"><span>${accountKeys().length ? 'New account' : 'Account'}</span>
          <input id="impAccount${sfx}" data-account-name="${i}" value="${F.chosen ? esc(F.account) : ''}" placeholder="e.g. ${esc(F.account)}"
            autocomplete="off" aria-label="Account name${many ? ` for ${esc(F.fileName)}` : ''}"></label>` : ''}
        ${F.needAccount && !F.chosen ? `<p class="fine warn" id="impNeedAccount${sfx}">${F.newAccount ? 'Name this account' : 'Choose which account this statement is from'} to import it.</p>` : ''}
        <div class="field"><span>Dates are</span>
          <div class="seg small grow">
            <button type="button" data-order="DMY" data-file="${i}" class="${F.order === 'DMY' ? 'on' : ''}">Day/Month</button>
            <button type="button" data-order="MDY" data-file="${i}" class="${F.order === 'MDY' ? 'on' : ''}">Month/Day</button>
          </div></div>
        <div class="field"><span>Money out is</span>
          <div class="seg small grow">
            <button type="button" data-flip="0" data-file="${i}" class="${F.fmt.flip ? '' : 'on'}" aria-label="Money out is shown as minus">− (minus)</button>
            <button type="button" data-flip="1" data-file="${i}" class="${F.fmt.flip ? 'on' : ''}" aria-label="Money out is shown as plus">+ (plus)</button>
          </div></div>
        ${ok ? `<label class="field toggle"><span>Set “Balance now”<br><span class="muted small-text">${money(F.check.latest.balance)} on ${esc(fmtDate(F.check.latest.date))} · used by Until payday</span></span>
          <input type="checkbox" id="impBalance${sfx}" data-balance="${i}" ${F.useBalance ? 'checked' : ''}></label>` : ''}
      </section>
      <p class="fine pad-x">${F.orderDetected ? 'Date order detected from the file.' : '<strong>Check the date order:</strong> this file could be read either way.'}
        ${sample ? `First row: ${esc(sample)} → ${sampleISO ? esc(dayMonthYear.format(C.parse(sampleISO))) : 'not a valid date'}.` : ''}</p>
      ${!F.check ? '' : !ok
        ? `<p class="fine pad-x warn" id="impCheck${sfx}"><strong>Check this file:</strong> the Balance column doesn’t add up with the amounts
          on ${F.check.pairs - agree} of ${F.check.pairs} rows.
          ${Bank.balancesAgree(other, F.check.pairs)
            ? `It does with money out as “${F.fmt.flip ? '−' : '+'}”.` : 'Some rows may be missing, or a column may have been read wrongly.'}
          You can still import it.</p>`
        : `<p class="fine pad-x" id="impCheck${sfx}">${F.autoFlip && F.fmt.flip
          ? '<strong>This file shows money out as “+”.</strong> The balances confirm it, so the signs have been switched. '
          : ''}✓ The amounts add up with the Balance column.</p>`}
      ${F.already ? `<p class="fine pad-x"><strong>${F.already}</strong> already imported or ignored — skipped.</p>` : ''}`;
  };

  sheet.innerHTML = `
  <div id="import">
    <div class="sheet-head">
      <button type="button" class="link" data-close>Cancel</button>
      <h2 tabindex="-1" autofocus>Import ${many ? `${imp.files.length} statements` : 'statement'}</h2>
      <button type="button" class="link strong" data-apply>Import</button>
    </div>
    <div class="sheet-body">
      ${imp.files.map(fileCard).join('')}
      <p class="fine pad-x">Choose the same account each time so transactions you've already imported are recognised.
        You can rename an account in Settings.${many ? ' Transfers between these accounts are paired up.' : ''}</p>

      ${imp.recurring.length ? `<div class="group-title">Looks recurring — not in your groups yet</div>
      <section class="card list">${imp.recurring.map(g => `
        <div class="row static label-row">
          <div class="row-main"><div class="row-title">${esc(g.name)}</div>
            <div class="row-sub">${g.txns.length} × ${g.variable ? '≈' : ''}${money(g.amount)} · ${C.FREQ[g.frequency].label.toLowerCase()} · ${esc(g.payee)}</div></div>
          <button type="button" class="btn small ${imp.newGroups.has(g.key) ? 'on-btn' : ''}" data-new="${esc(g.key)}">${imp.newGroups.has(g.key) ? '✓ Adding' : 'Add as payee group'}</button>
        </div>`).join('')}</section>` : ''}

      ${transfers.length ? `<div class="group-title">Transfers between your accounts (${transfers.length})</div>
      <p class="fine pad-x">Money moving between your own accounts (like paying off a card) isn’t spending or income,
        so these aren’t logged.${takesOut ? ' Where the other side was already imported as spending, it’s taken out of it.' : ''}
        Choose something else for any that aren’t transfers.</p>
      <section class="card">${transfers.map(txRow).join('')}</section>` : ''}

      ${suggested.length ? `<div class="group-title">Matched (${suggested.length})</div>
      <details class="imp-matched" data-pg="__matched" ${matchedOpen ? 'open' : ''}>
        <summary>✓ ${suggested.length} transaction${suggested.length === 1 ? '' : 's'} going to ${matchedEntries} payee group${matchedEntries === 1 ? '' : 's'}, nothing to do.
          <span class="imp-show">${matchedOpen ? 'Hide' : 'Review'}</span></summary>
        <section class="card">${matchedList.map(matchedRow).join('')}</section>
      </details>` : ''}

      ${rest.length ? `<div class="group-title">Not matched (${payeeList.length} payee${payeeList.length === 1 ? '' : 's'}, ${rest.length} transaction${rest.length === 1 ? '' : 's'})
        <button type="button" class="link small-link" data-ignore-rest>Ignore all of these</button></div>
      <p class="fine pad-x">Each payee gets a payee group of its own unless you choose something else. Very similar names
        (the same shop in different towns) share one. Nothing here needs sorting now — give two payees the same name to
        put them together, or move them later from Settings → Payees.</p>
      <section class="card">${payeeList.map(payeeRow).join('')}</section>` : ''}

      ${!imp.txns.length ? `<p class="empty-small">Nothing new in ${many ? 'these files' : 'this file'}.</p>` : ''}
      <p class="fine pad-x">Matched transactions are logged as payments in that group. Payees you choose yourself, or that
        match a group's name, are remembered for next time. Set a remembered one to “Skip for now” to
        forget it. “Skip for now” leaves a transaction to decide on a later import.</p>
      <button type="button" class="btn primary" data-apply>Import ${chosen} payment${chosen === 1 ? '' : 's'}</button>
    </div>
  </div>`;

  const root = $('#import');
  const fileOf = el => imp.files[Number(el.closest('[data-file]')?.dataset.file ?? el.dataset.file ?? 0)];
  root.addEventListener('toggle', ev => {
    const det = ev.target.closest?.('details[data-pg]');
    if (!det) return;
    det.open ? imp.openGroups.add(det.dataset.pg) : imp.openGroups.delete(det.dataset.pg);
    const show = det.querySelector(':scope > summary .imp-show');
    if (show) show.textContent = det.open ? 'Hide' : 'Review';
  }, true);
  root.addEventListener('change', ev => {
    const s = ev.target.closest('select[data-txn], select[data-pgroup]');
    if (s && s.value === 'pick') return pickForRow(s);
    if (s) {
      const v = s.value;
      if (s.dataset.pgroup) imp.pgroups.get(s.dataset.pgroup)?.txns.forEach(x => imp.decision.set(x.id, v));
      else imp.decision.set(s.dataset.txn, v);
      // A new entry takes this payee's other undecided transactions too
      if (v.startsWith('new:')) {
        const g = imp.recurring.find(x => x.key === v.slice(4));
        imp.newGroups.add(g.key);
        imp.offGroups.delete(g.key);
        g.txns.forEach(x => { const cur = imp.decision.get(x.id) || ''; if (!cur || cur.startsWith('catch:')) imp.decision.set(x.id, v); });
      }
      if (v.startsWith('make:')) {
        imp.txns.forEach(x => {
          const cur = imp.decision.get(x.id) || '';
          if (x.payee === v.slice(5) && (!cur || cur.startsWith('catch:'))) imp.decision.set(x.id, v);
        });
      }
      // A recurring payee whose transactions were all sent elsewhere isn't added as an entry
      const used = new Set(imp.decision.values());
      for (const k of [...imp.newGroups]) if (!used.has(`new:${k}`)) { imp.newGroups.delete(k); imp.offGroups.add(k); }
      return openImportKeepScroll();
    }
    if (ev.target.dataset.accountPick != null) {
      const F = fileOf(ev.target);
      const k = ev.target.value;
      F.newAccount = k === NEW_ACCOUNT;
      F.chosen = !F.newAccount; // a new account needs its name first
      F.account = F.newAccount ? unusedName(F, imp.files) : k;
      if (!F.balanceTouched) F.useBalance = balanceByDefault(F) && !imp.files.some(G => G !== F && G.useBalance);
      buildImport(); openImportKeepScroll();
      if (F.newAccount) $(`#impAccount${imp.files.indexOf(F) ? `-${imp.files.indexOf(F)}` : ''}`)?.focus();
      return;
    }
    if (ev.target.dataset.accountName != null) {
      const F = fileOf(ev.target);
      const name = cleanLabel(ev.target.value);
      if (!name) { F.chosen = false; return openImportKeepScroll(); }
      const existing = findAccount(name); // typed the name of an account that exists: use it
      F.account = existing || name;
      F.chosen = true;
      F.newAccount = !existing;
      if (!F.balanceTouched) F.useBalance = balanceByDefault(F) && !imp.files.some(G => G !== F && G.useBalance);
      buildImport(); return openImportKeepScroll();
    }
    if (ev.target.dataset.balance != null) {
      const F = fileOf(ev.target);
      F.useBalance = ev.target.checked;
      F.balanceTouched = true;
      // Only one statement can set "Balance now"
      if (F.useBalance) imp.files.forEach(G => { if (G !== F && G.useBalance) { G.useBalance = false; G.balanceTouched = true; } });
      if (many) openImportKeepScroll();
    }
  });
  root.addEventListener('click', async ev => {
    const t = ev.target;
    if (t.closest('[data-close]')) { imp = null; return closeSheet(); }
    const o = t.closest('[data-order]');
    if (o) { fileOf(o).order = o.dataset.order; buildImport(); return openImportKeepScroll(); }
    const fl = t.closest('[data-flip]');
    if (fl) { fileOf(fl).fmt.flip = fl.dataset.flip === '1'; buildImport(); return openImportKeepScroll(); }
    const n = t.closest('[data-new]');
    if (n) {
      const g = imp.recurring.find(x => x.key === n.dataset.new);
      // Their transactions, and any refunds from them (money back the other way)
      const theirs = imp.txns.filter(x => g.txns.includes(x) || (!x.action && x.payee === g.payee && (x.amount < 0) !== (g.type === 'expense')));
      if (imp.newGroups.has(g.key)) {
        imp.newGroups.delete(g.key);
        imp.offGroups.add(g.key);
        theirs.forEach(x => { if (imp.decision.get(x.id) === `new:${g.key}`) imp.decision.set(x.id, ownEntry(x)); });
      } else {
        imp.newGroups.add(g.key);
        imp.offGroups.delete(g.key);
        theirs.forEach(x => { const cur = imp.decision.get(x.id) || ''; if (!cur || cur.startsWith('catch:') || cur === ownEntry(x)) imp.decision.set(x.id, `new:${g.key}`); });
      }
      return openImportKeepScroll();
    }
    const rn = t.closest('[data-rename-payee], [data-rename-group]');
    if (rn) {
      await renamePayee(rn.dataset.renameGroup ? imp.pgroups.get(rn.dataset.renameGroup).payees : rn.dataset.renamePayee);
      buildImport();
      return openImportKeepScroll();
    }
    if (t.closest('[data-ignore-rest]')) {
      imp.txns.forEach(x => { const cur = imp.decision.get(x.id) || ''; if (!x.action && (!cur || cur === imp.suggested.get(x.id))) imp.decision.set(x.id, 'ignore'); });
      return openImportKeepScroll();
    }
    if (t.closest('[data-apply]')) await applyImport();
  });

  if (!sheet.open) { document.body.classList.add('modal-open'); sheet.showModal(); }
}

/**
 * "Choose a group or type a name…" on an import row: the picker, offering the groups of similar
 * payees first. A typed name becomes a new group when you import.
 */
async function pickForRow(s) {
  const ts = s.dataset.pgroup ? imp.pgroups.get(s.dataset.pgroup)?.txns || [] : imp.txns.filter(x => x.id === s.dataset.txn);
  const lead = ts.find(t => t.amount < 0) || ts[0];
  if (!lead) return openImportKeepScroll();
  const type = lead.amount < 0 ? 'expense' : 'income';
  const name = s.dataset.pgroup ? imp.pgroups.get(s.dataset.pgroup).name : lead.name || Bank.payeeName(lead.payee);
  const choice = await pickGroup({ title: `Where does ${name} go?`, type, name, suggested: groupSuggestions(name, type) });
  if (choice) {
    let v = choice.id;
    if (choice.create) {
      // typed the name of a group this import is already adding: put them together
      const same = [...imp.named.keys()].find(n => n.toLowerCase() === choice.create.toLowerCase());
      v = `named:${same || choice.create}`;
      if (!same) imp.named.set(choice.create, type);
    }
    ts.forEach(x => imp.decision.set(x.id, v));
  }
  openImportKeepScroll();
}

/** Redraw the import sheet without jumping back to the top. */
export function openImportKeepScroll() {
  const y = sheet.scrollTop;
  openImport();
  sheet.scrollTop = y;
}

export async function applyImport() {
  // Every file needs an account first
  const unset = imp.files.filter(F => !F.chosen);
  if (unset.length) {
    unset.forEach(F => { F.needAccount = true; });
    openImportKeepScroll();
    const i = imp.files.indexOf(unset[0]), sfx = i ? `-${i}` : '';
    const field = $(`#impAccount${sfx}`) || $(`#impAccountPick${sfx}`);
    field?.scrollIntoView({ block: 'center' });
    field?.focus();
    toast(unset.length === 1 && imp.files.length === 1 ? 'Choose an account first' : `Choose an account for each statement first`);
    return;
  }
  const now = new Date().toISOString();
  const accounts = [...new Set(imp.files.map(F => F.account))];
  // Everything this import adds is tagged or recorded, so "Undo last import" can take it back out.
  const batch = uid();
  const undo = { id: batch, at: now, account: accounts[0], accounts, file: imp.files.map(F => F.fileName).join(', '),
    files: imp.files.length, linked: [], takenOut: [], ignored: [], transfers: [] };
  const rulesBefore = getRules();
  const rules = getRules();
  const kindOf = acc => M.accountByKey(state.settings, acc)?.kind
    || (imp.files.find(F => F.account === acc)?.fmt.kind === 'card' ? 'credit' : Bank.guessAccountKind(acc));
  const methodOf = t => Bank.guessMethod(t.description, kindOf(t.account));
  const ignored = [...(state.settings.ignoredTxns || [])];
  const transfers = [...(state.settings.transfers || [])];
  const changed = new Map(); // entry id → updated entry
  const get = id => changed.get(id) || state.entries.find(e => e.id === id);
  let logged = 0, ignoredCount = 0, linked = 0, transferCount = 0, takenOut = 0;
  const links = importLinks();
  // The other side of each transfer from an earlier import, worked out for the final choices
  const pairs = Bank.findTransfers(imp.txns.filter(t => imp.decision.get(t.id) === 'transfer'), transferPool());

  // New entries from recurring groups
  for (const key of imp.newGroups) {
    const g = imp.recurring.find(x => x.key === key);
    if (!g) continue;
    const id = uid();
    const start = g.txns[0].date;
    changed.set(id, {
      id, type: g.type, name: g.name, category: suggestCategory(g.name, g.type, [g.payee]), method: methodOf(g.txns.at(-1)), frequency: g.frequency, startDate: start,
      contractEnd: null, endsAtExpiry: false, endDate: null, notes: `Added from a bank import (${g.payee})`, tags: [], fromImport: true, importBatch: batch,
      prices: [{ from: start, amount: g.variable ? null : g.amount, frequency: g.frequency }],
      variable: g.variable, manual: false, share: 100, noticeDays: null, payments: [], createdAt: now, updatedAt: now,
    });
    g.newId = id;
    rules[g.payee] = id;
  }

  // New entries for single payees ("+ New entry" on a transaction)
  const made = new Map(); // payee → new entry id
  for (const payee of new Set([...imp.decision.values()].filter(d => d.startsWith('make:')).map(d => d.slice(5)))) {
    const txns = imp.txns.filter(t => imp.decision.get(t.id) === `make:${payee}`).sort((a, b) => a.date.localeCompare(b.date));
    if (!txns.length) continue;
    const id = uid();
    // A payee's own entry, with no set schedule (even after one purchase: there may be more)
    const frequency = 'irregular';
    const start = txns[0].date;
    // Other payees may have been put in with it; refunds from them don't make it an income
    const lead = txns.find(t => t.payee === payee && t.amount < 0) || txns.find(t => t.payee === payee) || txns[0];
    changed.set(id, {
      id, type: lead.amount < 0 ? 'expense' : 'income', name: makeName(payee, lead),
      category: suggestCategory(makeName(payee, lead), lead.amount < 0 ? 'expense' : 'income', [...new Set(txns.map(t => t.payee))]),
      method: methodOf(lead), frequency, startDate: start, contractEnd: null, endsAtExpiry: false, endDate: null,
      notes: `Added from a bank import (${payee})`, tags: [], fromImport: true, importBatch: batch,
      prices: [{ from: start, amount: null, frequency }],
      variable: true, manual: false, share: 100, noticeDays: null, payments: [], createdAt: now, updatedAt: now,
    });
    made.set(payee, id);
    // Later purchases from them (and the similar payees put in with them) go to it too
    for (const k of new Set(txns.map(t => t.payee))) rules[k] = id;
  }

  // New groups you typed a name for in the picker
  const namedIds = new Map(); // name → new entry id
  for (const [name, type] of imp.named) {
    const txns = imp.txns.filter(t => imp.decision.get(t.id) === `named:${name}`).sort((a, b) => a.date.localeCompare(b.date));
    if (!txns.length) continue;
    const e = newGroup({ name, type, start: txns[0].date, method: methodOf(txns[0]), category: suggestCategory(name, type),
      notes: 'Added from a bank import', fromImport: true, importBatch: batch });
    changed.set(e.id, e);
    namedIds.set(name, e.id);
  }

  // Each account's catch-all entries, created the first time they're needed
  const catchIds = new Map(); // catchKey(account, type) → entry id
  let createdCatch = 0;
  for (const t of imp.txns) {
    const d = imp.decision.get(t.id) || '';
    if (!d.startsWith('catch:')) continue;
    const type = d.slice(6), key = catchKey(t.account, type);
    if (catchIds.has(key)) {
      const e = changed.get(catchIds.get(key));
      if (e && e.importBatch === batch && t.date < e.startDate) changed.set(e.id, { ...e, startDate: t.date, prices: [{ ...e.prices[0], from: t.date }] });
      continue;
    }
    const existing = catchEntry(t.account, type);
    if (existing) { catchIds.set(key, existing.id); continue; }
    const id = uid();
    changed.set(id, {
      id, type, name: catchName(t.account, type), category: '', method: methodOf(t), frequency: 'irregular',
      startDate: t.date, contractEnd: null, endsAtExpiry: false, endDate: null,
      notes: 'Everything from bank imports that isn’t matched to another group. Open its Accounts page to move a payee into a group of its own.',
      tags: [], fromImport: true, importBatch: batch, catchAll: key,
      prices: [{ from: t.date, amount: null, frequency: 'irregular' }],
      variable: true, manual: false, share: 100, noticeDays: null, payments: [], createdAt: now, updatedAt: now,
    });
    catchIds.set(key, id);
    createdCatch++;
  }

  for (const t of imp.txns) {
    let d = imp.decision.get(t.id) || '';
    const chosen = d;
    const suggested = imp.suggested.get(t.id) || '';
    if (!d) {
      // A remembered choice switched to "Skip for now": it was wrong, so forget it.
      if (t.why === 'rule' && suggested && suggested !== 'ignore') { delete rules[t.payee]; delete rules[t.oldPayee]; }
      continue;
    }
    if (d === 'transfer') {
      transfers.push({ id: t.id, account: t.account.toLowerCase(), date: t.date, amount: t.amount });
      undo.transfers.push(t.id);
      transferCount++;
      if (chosen !== suggested) rules[t.payee] = 'transfer';
      // The other side went into a catch-all entry on an earlier import: take it out, as a transfer.
      const o = pairs.get(t.id);
      if (o?.kind === 'payment') {
        const e = get(o.entryId);
        if (e) {
          changed.set(e.id, { ...e, payments: e.payments.filter(p => p.id !== o.paymentId), updatedAt: now });
          undo.takenOut.push({ entryId: e.id, payment: e.payments.find(p => p.id === o.paymentId) });
          transfers.push({ id: o.id, account: o.account, date: o.date, amount: o.amount });
          undo.transfers.push(o.id);
          takenOut++;
        }
      }
      continue;
    }
    if (d === 'ignore' || d === 'ignore-payee') {
      ignored.push({ id: t.id, date: t.date }); undo.ignored.push(t.id); ignoredCount++;
      if (d === 'ignore-payee') rules[t.payee] = 'ignore';
      continue;
    }
    if (d.startsWith('new:')) d = imp.recurring.find(g => g.key === d.slice(4))?.newId;
    else if (d.startsWith('make:')) d = made.get(d.slice(5));
    else if (d.startsWith('named:')) d = namedIds.get(d.slice(6));
    else if (d.startsWith('catch:')) d = catchIds.get(catchKey(t.account, d.slice(6)));
    const e = d && get(d);
    if (!e) continue;
    // Payments are stored as the bill amount: money out on an expense (or in on income) is positive;
    // the other direction is a refund/credit (negative).
    const amount = e.type === 'expense' ? -t.amount : t.amount;
    const link = links.get(t.id);
    const note = (t.name ? `${t.name} · ${t.description}` : t.description).slice(0, 100);
    if (link) {
      // Already logged by hand: keep that payment, but take the bank's actual date and amount.
      undo.linked.push(e.payments.find(p => p.id === link.id));
      const payments = e.payments.map(p => (p.id === link.id
        ? { ...p, date: t.date, amount, due: p.due || Bank.nearestDue(e, t.date), note: p.note || note, source: t.id, payee: t.payee, account: t.account,
          method: p.method || methodOf(t), handLogged: true }
        : p));
      changed.set(e.id, { ...e, payments, updatedAt: now });
      linked++;
    } else {
      const payment = { id: uid(), date: t.date, amount, due: Bank.nearestDue(e, t.date), note, source: t.id, payee: t.payee, account: t.account,
        method: methodOf(t), batch };
      changed.set(e.id, { ...e, payments: [...(e.payments || []), payment], updatedAt: now });
    }
    // Remember the payee only for choices you made, name matches and existing rules. A match on
    // amount alone is a one-off guess and mustn't send every future purchase there.
    // Never to a one-off (later purchases don't belong to it) or a catch-all (where they go anyway).
    if ((chosen !== suggested || t.why === 'rule' || t.why === 'similar' || t.byName) && e.frequency !== 'once' && !isCatchAll(e)) rules[t.payee] = e.id;
    logged++;
  }

  // A payee's entry an earlier import added, left empty once its only payment turned out to be a
  // transfer, goes (Undo puts it back)
  const removed = [];
  for (const x of undo.takenOut) {
    const e = changed.get(x.entryId);
    if (!e || e.payments.length || !e.fromImport || e.catchAll || e.importBatch === batch) continue;
    removed.push(state.entries.find(o => o.id === e.id));
    changed.delete(e.id);
    for (const [k, v] of Object.entries(rules)) if (v === e.id) delete rules[k];
  }
  undo.removedEntries = removed.filter(Boolean);

  const toSave = [...changed.values()].map(normalizeEntry).filter(Boolean);
  if (toSave.length) await db.putEntries(toSave);
  for (const e of undo.removedEntries) await db.deleteEntry(e.id);
  undo.payees = setRules(rules);
  // Every payee something was logged from gets a record, so it shows in Settings → Payees
  const loggedKeys = [...changed.values()].flatMap(e => (e.payments || []).filter(p => p.batch === batch || p.source && links.has(p.source)).map(p => p.payee));
  const more = M.withPayees(state.settings, loggedKeys, uid);
  state.settings.payees = more.payees;
  undo.payees.push(...more.added);
  state.settings.ignoredTxns = keepNewest(ignored, IGNORED_MAX);
  state.settings.transfers = keepNewest(transfers, IGNORED_MAX);
  const setter = imp.files.find(F => F.useBalance && balanceOK(F));
  if (setter) {
    undo.balance = { before: state.settings.balance || null, account: setter.account };
    state.settings.balance = { amount: setter.check.latest.balance, date: setter.check.latest.date, account: setter.account };
  }
  // Payee rules this import changed, and what they were before
  undo.rules = Object.fromEntries([...new Set([...Object.keys(rulesBefore), ...Object.keys(rules)])]
    .filter(k => rulesBefore[k] !== rules[k]).map(k => [k, { before: rulesBefore[k] ?? null, after: rules[k] ?? null }]));
  undo.payments = logged - linked;
  state.settings.importLog = [...(state.settings.importLog || []), undo].slice(-5);
  undo.newAccounts = accounts.filter(a => !M.accountByKey(state.settings, a));
  state.settings.accounts = M.withAccounts(state.settings, accounts, kindOf);
  // Each file with a Balance column records its account's balance
  for (const F of imp.files) if (balanceOK(F)) {
    const acc = M.accountByKey(state.settings, F.account);
    if (!acc.balance || acc.balance.date <= F.check.latest.date) {
      (undo.accountBalances ||= []).push({ key: acc.key, before: acc.balance || null });
      state.settings.accounts = M.updateAccount(state.settings, F.account, { balance: { amount: F.check.latest.balance, date: F.check.latest.date } });
    }
  }
  await saveSettings();
  const added = imp.newGroups.size + made.size + namedIds.size + createdCatch;
  imp = null;
  closeSheet();
  await reload();
  const fresh = logged - linked;
  toast(`Logged ${fresh} payment${fresh === 1 ? '' : 's'}${linked ? `, updated ${linked} you'd logged` : ''}${added ? `, added ${added} payee group${added === 1 ? '' : 's'}` : ''}${transferCount ? `, ${transferCount} transfer${transferCount === 1 ? '' : 's'}` : ''}${takenOut ? ` (${takenOut} taken out of spending)` : ''}${ignoredCount ? `, ignored ${ignoredCount}` : ''}`);
}
