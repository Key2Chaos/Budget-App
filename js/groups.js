// Moving payments between groups, and tidying up afterwards. Every move and merge goes through here
// (Move to…, Move… on a payment, Settings → Payees, merging payees or groups), so they all behave
// the same: payments end up in one group, and a group the app made that's left empty goes.
import { db } from './db.js';
import * as C from './calc.js';
import * as Bank from './bank.js';
import * as M from './model.js';
import { normalizeEntry } from './schema.js';
import { state, saveSettings } from './core.js';

/**
 * Move payments ([{ p, e }]: a payment and the group it's in) into `dest`, which may be a new group
 * not saved yet. Into a group of the other type the sign flips (money out becomes a refund on
 * income). Saves the changed groups; call reload() after.
 */
export async function movePayments(list, dest, now = new Date().toISOString()) {
  const changed = new Map([[dest.id, { ...dest, payments: [...(dest.payments || [])] }]]);
  for (const { p, e } of list) {
    if (e.id === dest.id) continue;
    const from = changed.get(e.id) || { ...e, payments: [...(e.payments || [])] };
    from.payments = from.payments.filter(x => x.id !== p.id);
    changed.set(e.id, from);
    const to = changed.get(dest.id);
    to.payments.push({ ...p, amount: e.type === dest.type ? p.amount : -p.amount, due: Bank.nearestDue(to, p.date) });
  }
  // A group with no set schedule starts at its first payment
  const to = changed.get(dest.id);
  const first = to.payments.reduce((d, p) => (p.date < d ? p.date : d), to.startDate);
  if (C.isIrregular(to) && first < to.startDate) Object.assign(to, { startDate: first, prices: [{ ...to.prices[0], from: first }, ...to.prices.slice(1)] });
  const out = [...changed.values()].map(e => normalizeEntry({ ...e, updatedAt: now })).filter(Boolean);
  if (out.length) await db.putEntries(out);
  return out;
}

/**
 * A group the app made (by an import, or a name typed in the picker) with no schedule you set up:
 * none at all, or only the one an import guessed (e.g. "Monthly $223.25") and you haven't changed.
 */
export const isAutoGroup = e => !!(e.fromImport || e.catchAll)
  && (!e.scheduleSetByYou || (C.isIrregular(e) && !e.prices.some(p => p.amount != null && p.amount > 0)));

/** Nothing refers to the group: no payments, no payee goes there, no budget for it. */
const isUnused = e => !(e.payments || []).length
  && !M.payeesOf(state.settings).some(p => p.groupId === e.id)
  && !(state.settings.budgets || []).some(b => b.kind === 'group' && b.groupId === e.id);

/**
 * Remove the groups among `ids` that the app made and that are now empty and unused (e.g. a payee's
 * own group after its payments moved elsewhere). Groups you set up yourself always stay.
 * Uses state.entries, so reload() first. Returns the names of the groups removed.
 */
export async function removeEmptyGroups(ids) {
  const want = new Set(ids);
  const gone = state.entries.filter(e => want.has(e.id) && isAutoGroup(e) && isUnused(e));
  for (const e of gone) await db.deleteEntry(e.id);
  if (gone.length) state.entries = state.entries.filter(e => !gone.includes(e));
  return gone.map(e => e.name);
}

/** "· Kmart Bondi removed (empty)" for a toast. */
export const removedNote = names => (names.length
  ? ` · ${names.length === 1 ? `“${names[0]}”` : `${names.length} groups`} removed (empty)` : '');

/**
 * The group a payee's payments belong in: its group if it has one, else the group already holding
 * most of them. pays: [{ p, e }]. Null when there are none.
 */
export function homeGroup(payee, pays) {
  const own = payee.groupId && state.entries.find(e => e.id === payee.groupId);
  if (own) return own;
  const count = new Map();
  for (const { e } of pays) count.set(e.id, (count.get(e.id) || 0) + 1);
  const best = [...count].sort((a, b) => b[1] - a[1])[0];
  return best ? state.entries.find(e => e.id === best[0]) || null : null;
}

/** Bump to sweep again when isAutoGroup covers more (2: imported groups with a guessed schedule). */
const SWEEP = 2;

/** Once per SWEEP, for data from before this tidy-up: remove empty groups that earlier moves left behind. */
export async function sweepEmptyGroups() {
  if ((state.settings.emptyGroupsSweep || 0) >= SWEEP) return [];
  const names = await removeEmptyGroups(state.entries.map(e => e.id));
  state.settings.emptyGroupsSweep = SWEEP;
  delete state.settings.emptyGroupsSwept;
  await saveSettings();
  return names;
}
