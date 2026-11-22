// Your accounts and payees (format v5). Pure — no DOM, no storage — so it's testable.
//
//   settings.accounts: [{ key, name, kind }]
//     key  — the name the account was first imported under. It's part of every transaction id, so it
//            never changes; `name` is what you see and can be renamed freely.
//     kind — 'transaction' | 'savings' | 'credit' | 'cash' | 'other'
//   settings.payees: [{ id, name, keys, groupId, rule }]
//     keys    — the bank's spellings of this payee (payee keys from bank.js). Several keys = the same
//               payee written different ways ("merging").
//     name    — your own name for them, or null to use the bank's text.
//     groupId — the group (entry) their transactions go to, or null (ungrouped). One per payee.
//     rule    — null, 'ignore' (always ignore) or 'transfer' (money between your own accounts).
//
// The importer works with plain maps keyed by payee key ({ key: groupId | 'ignore' | 'transfer' } and
// { key: name }); rulesMap / namesMap make those maps and applyRules / applyNames write them back.
import { payeeName } from './bank.js';

export const ACCOUNT_KINDS = { transaction: 'Everyday account', savings: 'Savings', credit: 'Credit card', cash: 'Cash', other: 'Other' };

const lc = s => String(s ?? '').toLowerCase();
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---------- Accounts ----------

export const accountsOf = s => s.accounts || [];
export const accountKeys = s => accountsOf(s).map(a => a.key);
/** An account's display name from its key (any case). Unknown keys show as they are. */
export const accountName = (s, key) => accountsOf(s).find(a => lc(a.key) === lc(key))?.name || key;
export const accountByKey = (s, key) => accountsOf(s).find(a => lc(a.key) === lc(key)) || null;
/** The key of the account with this key or display name (any case), or undefined. */
export const findAccount = (s, name) => {
  const n = lc(clean(name));
  return accountsOf(s).find(a => lc(a.key) === n || lc(a.name) === n)?.key;
};

/** Accounts with these keys added (newest first, as `bankAccounts` was), kinds guessed by `kindOf`. */
export function withAccounts(s, keys, kindOf = () => 'transaction') {
  const out = [...accountsOf(s)];
  for (const k of [...keys].reverse()) {
    if (!out.some(a => lc(a.key) === lc(k))) out.unshift({ key: k, name: k, kind: kindOf(k) });
  }
  return out;
}

/** Accounts with one changed: { name?, kind? }. */
export const updateAccount = (s, key, change) =>
  accountsOf(s).map(a => (lc(a.key) === lc(key) ? { ...a, ...change } : a));

// ---------- Payees ----------

export const payeesOf = s => s.payees || [];
export const payeeByKey = (s, key) => (key ? payeesOf(s).find(p => p.keys.includes(key)) || null : null);
export const payeeById = (s, id) => payeesOf(s).find(p => p.id === id) || null;
/** What a payee is called: your name, else a readable form of the bank's text. */
export const payeeTitle = p => p.name || payeeName(p.keys[0] || '');
/** A payee key's display name. */
export const keyTitle = (s, key) => { const p = payeeByKey(s, key); return p ? payeeTitle(p) : payeeName(key); };

/** { key: groupId | 'ignore' | 'transfer' } for every key of every payee that has one. */
export function rulesMap(s) {
  const out = {};
  for (const p of payeesOf(s)) {
    const v = p.rule || p.groupId;
    if (v) for (const k of p.keys) out[k] = v;
  }
  return out;
}

/** { key: your name } for every key of every payee you've named. */
export function namesMap(s) {
  const out = {};
  for (const p of payeesOf(s)) if (p.name) for (const k of p.keys) out[k] = p.name;
  return out;
}

const valueOf = p => p.rule || p.groupId || null;
const setValue = (p, v) => ({ ...p, rule: v === 'ignore' || v === 'transfer' ? v : null,
  groupId: v && v !== 'ignore' && v !== 'transfer' ? v : null });

/**
 * Payees updated from a rules map. A payee whose keys now say something different takes the new
 * value (all its keys go together: one group per payee); a key with no payee yet gets a new payee.
 * Keys missing from the map clear their payee's group or rule, but the payee itself stays.
 * Returns { payees, added } — added lists the ids of new payees.
 */
export function applyRules(s, rules, newId) {
  const added = [];
  const payees = payeesOf(s).map(p => {
    const cur = valueOf(p);
    const vals = p.keys.map(k => rules[k] ?? null);
    const changed = vals.filter(v => v !== cur);
    return changed.length ? setValue(p, changed.at(-1)) : p;
  });
  const have = new Set(payees.flatMap(p => p.keys));
  for (const [k, v] of Object.entries(rules)) {
    if (have.has(k) || !v) continue;
    const p = setValue({ id: newId(), name: null, keys: [k] }, v);
    payees.push(p); added.push(p.id); have.add(k);
  }
  return { payees, added };
}

/** Payees updated from a names map (as `applyRules`, for names). */
export function applyNames(s, names, newId) {
  const added = [];
  const payees = payeesOf(s).map(p => {
    const named = p.keys.map(k => names[k]).filter(Boolean);
    const name = named.length ? named.find(n => n !== p.name) || named[0] : null;
    return name === (p.name || null) ? p : { ...p, name };
  });
  const have = new Set(payees.flatMap(p => p.keys));
  for (const [k, name] of Object.entries(names)) {
    if (have.has(k) || !name) continue;
    const p = { id: newId(), name, keys: [k], groupId: null, rule: null };
    payees.push(p); added.push(p.id); have.add(k);
  }
  return { payees, added };
}

/** Payees with a record for each of these keys (new ones ungrouped). */
export function withPayees(s, keys, newId) {
  const payees = [...payeesOf(s)];
  const have = new Set(payees.flatMap(p => p.keys));
  const added = [];
  for (const k of keys) {
    if (!k || have.has(k)) continue;
    const p = { id: newId(), name: null, keys: [k], groupId: null, rule: null };
    payees.push(p); added.push(p.id); have.add(k);
  }
  return { payees, added };
}

/** Payees with one changed: { name?, groupId?, rule? }. Setting a group clears the rule and vice versa. */
export function updatePayee(s, id, change) {
  return payeesOf(s).map(p => {
    if (p.id !== id) return p;
    const out = { ...p, ...change };
    if ('groupId' in change && change.groupId) out.rule = null;
    if ('rule' in change && change.rule) out.groupId = null;
    if ('name' in change) out.name = clean(change.name) || null;
    return out;
  });
}

/**
 * Payees with `fromId` merged into `intoId`: one payee with both sets of bank spellings. The kept
 * payee keeps its name, group and rule, taking the other's where it has none.
 */
export function mergePayees(s, intoId, fromId) {
  const into = payeeById(s, intoId), from = payeeById(s, fromId);
  if (!into || !from || into === from) return payeesOf(s);
  const merged = { ...into, keys: [...new Set([...into.keys, ...from.keys])],
    name: into.name || from.name, groupId: into.groupId || (into.rule ? null : from.groupId),
    rule: into.rule || (into.groupId ? null : from.rule) };
  return payeesOf(s).filter(p => p.id !== fromId).map(p => (p.id === intoId ? merged : p));
}

/** Payees no longer in a deleted group: they become ungrouped. */
export const ungroup = (s, groupId) => payeesOf(s).map(p => (p.groupId === groupId ? { ...p, groupId: null } : p));

// ---------- Tidying stored data ----------

const KIND_OK = new Set(Object.keys(ACCOUNT_KINDS));

/** Accounts as stored: unique keys, a name, a known kind. */
export function normalizeAccounts(list) {
  const seen = new Set(), out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const key = clean(a?.key);
    if (!key || seen.has(lc(key))) continue;
    seen.add(lc(key));
    out.push({ ...a, key, name: clean(a.name) || key, kind: KIND_OK.has(a.kind) ? a.kind : 'transaction' });
  }
  return out;
}

/** Payees as stored: an id, at least one key, no key in two payees. */
export function normalizePayees(list) {
  const ids = new Set(), keys = new Set(), out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p.id !== 'string' || !p.id || ids.has(p.id)) continue;
    const ks = [...new Set((Array.isArray(p.keys) ? p.keys : []).filter(k => typeof k === 'string' && k && !keys.has(k)))];
    if (!ks.length) continue;
    ids.add(p.id); ks.forEach(k => keys.add(k));
    const rule = p.rule === 'ignore' || p.rule === 'transfer' ? p.rule : null;
    out.push({ ...p, keys: ks, name: clean(p.name) || null, rule,
      groupId: !rule && typeof p.groupId === 'string' && p.groupId ? p.groupId : null });
  }
  return out;
}
