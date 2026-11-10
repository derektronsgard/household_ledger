/* Household Ledger — app logic. Plain JavaScript, no build step. */
(function () {
  const P = window.Parse;
  const ACCOUNTS = {
    wf: { name: 'Wells Fargo', type: 'bank' },
    c1: { name: 'Capital One', type: 'card', highlight: true },
  };
  const S = {
    pass: localStorage.getItem('hl_pass') || '',
    tab: localStorage.getItem('hl_tab') || 'overview',
    month: monthKey(new Date()),
    categories: [], transactions: [], rules: [], budgets: [], settings: {},
    filter: { q: '', account: '', cat: '', allMonths: false },
    openTx: null,
    preview: null, // import preview state
    importAccount: 'wf',
  };

  // ---------- utils ----------
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => (n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt0 = n => (n < 0 ? '−' : '') + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
  function monthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function monthLabel(k) { const [y, m] = k.split('-'); return new Date(+y, +m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }); }
  function shiftMonth(k, n) { const [y, m] = k.split('-'); return monthKey(new Date(+y, +m - 1 + n, 1)); }
  function shortDate(iso) { const [y, m, d] = iso.split('-'); return new Date(+y, +m - 1, +d).toLocaleString('en-US', { month: 'short', day: 'numeric' }); }
  const catById = id => S.categories.find(c => c.id === id);
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'cat';

  let toastTimer;
  function toast(html, actions = [], ms = 4500) {
    const el = $('#toast');
    el.innerHTML = `<span>${html}</span>` + actions.map((a, i) => `<button class="btn ${a.quiet ? 'quiet' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('');
    el.hidden = false;
    el.querySelectorAll('button').forEach(b => b.onclick = () => { el.hidden = true; actions[+b.dataset.i].run(); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.hidden = true, ms);
  }

  // ---------- API ----------
  async function api(body) {
    const r = await fetch('/api/db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-passcode': S.pass },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({ error: 'The server sent back something unexpected (' + r.status + ').' }));
    if (r.status === 401) { logout(); throw new Error('Wrong passcode'); }
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  async function save(table, rows, opts = {}) {
    try { await api({ action: 'upsert', table, rows, ignoreDuplicates: !!opts.ignoreDuplicates }); }
    catch (e) { toast('Not saved: ' + esc(e.message), [], 8000); throw e; }
  }
  async function del(table, ids) {
    try { await api({ action: 'delete', table, ids }); }
    catch (e) { toast('Not deleted: ' + esc(e.message), [], 8000); throw e; }
  }
  const txRow = t => ({ id: t.id, account: t.account, date: t.date, description: t.description, amount: +t.amount, category_id: t.category_id || null, note: t.note || '' });
  const catRow = c => ({ id: c.id, name: c.name, grp: c.grp, kind: c.kind, budget: +c.budget || 0, sort: +c.sort || 0, archived: !!c.archived });
  const ruleRow = r => ({ id: r.id, pattern: r.pattern, category_id: r.category_id, direction: r.direction || 'any' });

  async function loadAll() {
    const d = await api({ action: 'load' });
    S.categories = d.categories; S.rules = d.rules; S.budgets = d.budgets;
    S.transactions = d.transactions.map(t => ({ ...t, amount: +t.amount }));
    S.categories.forEach(c => c.budget = +c.budget);
    S.budgets.forEach(b => b.amount = +b.amount);
    S.settings = {};
    (d.settings || []).forEach(r => { try { S.settings[r.id] = JSON.parse(r.value); } catch {} });
  }

  // ---------- categorizing ----------
  function ruleFor(t) {
    const d = P.normDesc(t.description) + ' | ' + P.cleanDesc(t.description);
    const hits = S.rules.filter(r => {
      if (!r.pattern || !d.includes(r.pattern.toUpperCase())) return false;
      if (r.direction === 'in' && t.amount <= 0) return false;
      if (r.direction === 'out' && t.amount >= 0) return false;
      return catById(r.category_id);
    });
    hits.sort((a, b) => b.pattern.length - a.pattern.length);
    return hits[0] ? hits[0].category_id : null;
  }
  function autoCategory(t) {
    const type = (ACCOUNTS[t.account] || {}).type;
    if (P.isCardPayment(t, type) && catById('cc-payment')) return 'cc-payment';
    const byRule = ruleFor(t); // a rule can claim a transfer, e.g. a paycheck moved in from another account
    if (byRule) return byRule;
    if (P.isTransfer(t) && catById('transfer')) return 'transfer';
    return bankCategoryFor(t);
  }
  // Capital One's own category column, used only when no rule matches.
  const BANK_CATEGORIES = {
    'dining': 'dining', 'gas/automotive': 'gas', 'insurance': 'insurance', 'fee/interest charge': 'fees',
    'phone/cable': 'phone-internet', 'internet': 'subscriptions', 'entertainment': 'entertainment',
    'other travel': 'travel', 'airfare': 'travel', 'lodging': 'travel', 'car rental': 'travel',
    'health care': 'health', 'healthcare': 'health', 'utilities': 'utilities',
  };
  function bankCategoryFor(t) {
    const id = BANK_CATEGORIES[String(t.bankCategory || '').toLowerCase()];
    return id && catById(id) && !catById(id).archived ? id : null;
  }

  // ---------- month math ----------
  function txInMonth(k) { return S.transactions.filter(t => t.date.startsWith(k)); }
  function budgetFor(cat, k) {
    const o = S.budgets.find(b => b.month === k && b.category_id === cat.id);
    return o ? o.amount : cat.budget;
  }
  function monthTotals(k) {
    const txs = txInMonth(k);
    const byCat = {}; let income = 0, spent = 0, unc = 0, uncSum = 0;
    for (const t of txs) {
      const c = catById(t.category_id);
      if (!c) { unc++; uncSum += t.amount; continue; }
      byCat[c.id] = (byCat[c.id] || 0) + t.amount;
      if (c.kind === 'income') income += t.amount;
      else if (c.kind === 'expense') spent -= t.amount;
    }
    return { byCat, income, spent, unc, uncSum, count: txs.length };
  }
  // Credit card: what went on it this month, what was paid, and what's owed.
  // With a known balance B on date A: owed(D) = B + sum(amounts dated <= A) - sum(amounts dated <= D).
  function cardStatus(acct, k) {
    const txs = S.transactions.filter(t => t.account === acct);
    const type = ACCOUNTS[acct].type;
    const inMonth = txs.filter(t => t.date.startsWith(k));
    let charges = 0, credits = 0, payments = 0;
    for (const t of inMonth) {
      if (t.amount < 0) charges -= t.amount;
      else if (P.isCardPayment(t, type) || t.category_id === 'cc-payment') payments += t.amount;
      else credits += t.amount;
    }
    const anchor = S.settings['card-balance:' + acct];
    const sumTo = D => txs.reduce((s, t) => s + (t.date <= D ? t.amount : 0), 0);
    const [y, m] = k.split('-').map(Number);
    const monthEnd = `${k}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    const today = new Date(); const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const asOf = monthEnd < todayIso ? monthEnd : todayIso;
    const owedAt = D => (anchor ? anchor.balance + sumTo(anchor.date) : 0) - sumTo(D);
    const lastTx = txs.reduce((mx, t) => t.date > mx ? t.date : mx, '');
    return { charges, credits, payments, net: charges - credits, owed: owedAt(asOf), asOf, isPast: monthEnd < todayIso, anchor, count: inMonth.length, any: txs.length > 0, lastTx };
  }

  function cardPanel(acct) {
    const a = ACCOUNTS[acct]; const c = cardStatus(acct, S.month);
    if (!c.any) return '';
    const mName = monthLabel(S.month).split(' ')[0];
    const owed = Math.round(c.owed * 100) / 100;
    const payLine = !c.anchor
      ? `To cover ${esc(mName)}'s charges, pay <b class="money">${fmt(Math.max(0, c.net))}</b>. Enter your card balance below to see the exact payoff amount.`
      : owed > 0.005
      ? `Pay <b class="money">${fmt(owed)}</b> to bring the card to $0${c.isPast ? ` (balance at the end of ${mName})` : ''}.`
      : owed < -0.005 ? `The card shows a credit of <b class="money">${fmt(-owed)}</b>. Nothing to pay.` : `The card is paid off. Nothing to pay.`;
    return `<section class="card-panel" aria-label="${esc(a.name)} card">
      <div class="row" style="justify-content:space-between;align-items:baseline">
        <h3 style="margin:0">${esc(a.name)} card in ${esc(mName)}</h3>
        <button class="btn quiet" data-cardtx="${acct}">See ${c.count} charge${c.count === 1 ? '' : 's'} and payments</button>
      </div>
      <div class="card-figs">
        <div><span>Charged</span><strong class="money">${fmt(c.charges)}</strong>${c.credits ? `<small>${fmt(c.credits)} in refunds</small>` : ''}</div>
        <div><span>Paid</span><strong class="money">${fmt(c.payments)}</strong></div>
        <div><span>Balance ${c.isPast ? 'at month end' : 'now'}</span><strong class="money ${!c.anchor ? 'muted' : owed > 0.005 ? 'owed' : 'in'}">${c.anchor ? fmt(Math.max(0, owed)) : 'Not set'}</strong></div>
      </div>
      <p class="pay-line">${payLine}</p>
      ${c.anchor
        ? `<p class="small muted">Balance is based on ${fmt(c.anchor.balance)} owed on ${shortDate(c.anchor.date)}, plus everything imported since. <a href="#" data-anchoredit="${acct}">Update it</a></p>`
        : `<p class="small muted">Enter the balance shown in the ${esc(a.name)} app once, and it stays current as you import. <a href="#" data-anchoredit="${acct}">Enter balance</a></p>`}
      <form class="row anchor-form" data-anchorform="${acct}" hidden>
        <label class="small">Balance owed <input type="number" step="0.01" name="bal" required style="width:120px" value="${c.anchor ? c.anchor.balance : ''}"></label>
        <label class="small">as of <input type="date" name="date" required value="${c.anchor ? c.anchor.date : (c.lastTx || '')}"></label>
        <button class="btn primary" type="submit">Save balance</button>
        <span class="small muted" style="flex-basis:100%">Pick a date whose transactions are all imported, like the last date in your latest download.</span>
      </form>
    </section>`;
  }

  function paceFraction(k) {
    const now = new Date(); const cur = monthKey(now);
    if (k < cur) return 1; if (k > cur) return 0;
    const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return now.getDate() / days;
  }

  // ---------- rendering ----------
  function render() {
    $('#monthLabel').textContent = monthLabel(S.month);
    document.querySelectorAll('#tabs button').forEach(b => {
      b.setAttribute('aria-current', b.dataset.tab === S.tab ? 'page' : 'false');
      if (b.dataset.tab === 'transactions') {
        const n = S.transactions.filter(t => !catById(t.category_id)).length;
        b.innerHTML = 'Transactions' + (n ? `<span class="badge" title="Need a category">${n}</span>` : '');
      }
    });
    const v = $('#view');
    v.innerHTML = ({ overview, transactions, import: importView, budget, rules })[S.tab]();
    afterRender[S.tab] && afterRender[S.tab]();
  }

  function catOptions(selected, { blank = 'Choose a category…', includeArchived = false } = {}) {
    const groups = {};
    S.categories.filter(c => includeArchived || !c.archived || c.id === selected).forEach(c => (groups[c.grp] = groups[c.grp] || []).push(c));
    return `<option value="">${esc(blank)}</option>` + Object.entries(groups).map(([g, cs]) =>
      `<optgroup label="${esc(g)}">${cs.map(c => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
  }

  // Overview
  function overview() {
    if (!S.transactions.length) {
      return `<h2>Welcome</h2><p class="sub">Start by bringing in a Wells Fargo or Capital One statement. Once transactions are in, this page shows each budget category for the month and how much is left.</p>
        <button class="btn primary" data-go="import">Import a statement</button>`;
    }
    const T = monthTotals(S.month);
    const pace = paceFraction(S.month);
    const net = T.income - T.spent;
    const expectedIn = S.categories.filter(c => c.kind === 'income' && !c.archived).reduce((s, c) => s + budgetFor(c, S.month), 0);
    let html = `<h2>${esc(monthLabel(S.month))}</h2>
      <div class="ledger-line">
        <div><span>Money in</span><strong class="in money">${fmt0(T.income)}</strong>${expectedIn ? `<small class="exp">of ${fmt0(expectedIn)} expected</small>` : ''}</div>
        <div><span>Spent</span><strong class="money">${fmt0(T.spent)}</strong></div>
        <div><span>${net >= 0 ? 'Left over' : 'Short'}</span><strong class="money ${net < 0 ? 'over' : ''}">${fmt0(Math.abs(net))}</strong></div>
      </div>`;
    html += Object.keys(ACCOUNTS).filter(id => ACCOUNTS[id].type === 'card').map(cardPanel).join('');
    if (T.unc) html += `<div class="notice"><span><b>${T.unc}</b> transaction${T.unc === 1 ? '' : 's'} this month need${T.unc === 1 ? 's' : ''} a category (${fmt(T.uncSum)}). Totals leave ${T.unc === 1 ? 'it' : 'them'} out until then.</span><button class="btn" data-uncat>Sort them</button></div>`;
    if (!T.count) html += `<p class="sub">No transactions in ${esc(monthLabel(S.month))} yet.</p>`;

    const groups = {};
    S.categories.filter(c => c.kind === 'expense').forEach(c => {
      const b = budgetFor(c, S.month); const spent = -(T.byCat[c.id] || 0);
      if (c.archived && !spent) return;
      if (!b && !spent) return;
      (groups[c.grp] = groups[c.grp] || []).push({ c, b, spent });
    });
    let anyBudget = false;
    for (const [g, rows] of Object.entries(groups)) {
      const gb = rows.reduce((s, r) => s + r.b, 0), gs = rows.reduce((s, r) => s + r.spent, 0);
      html += `<section class="env-group"><h3>${esc(g)} <small>${fmt0(gs)}${gb ? ' of ' + fmt0(gb) : ''}</small></h3>`;
      for (const { c, b, spent } of rows) {
        if (b) {
          anyBudget = true;
          const pct = Math.max(0, Math.min(1, spent / b));
          const left = b - spent;
          const cls = spent > b ? 'over' : (spent > b * pace + 0.01 && pace < 1 ? 'hot' : '');
          html += `<div class="env" data-cat="${esc(c.id)}" title="See ${esc(c.name)} transactions">
            <span class="env-name">${esc(c.name)}</span>
            <div class="track"><div class="fill ${cls}" style="width:${(pct * 100).toFixed(1)}%"></div>${pace > 0 && pace < 1 ? `<div class="pace" style="left:${(pace * 100).toFixed(1)}%"></div>` : ''}</div>
            <span class="env-figs"><span class="left ${left < 0 ? 'over' : ''}">${left < 0 ? fmt0(-left) + ' over' : fmt0(left) + ' left'}</span><span class="of">${fmt0(spent)} of ${fmt0(b)}</span></span>
          </div>`;
        } else {
          html += `<div class="env" data-cat="${esc(c.id)}"><span class="env-name">${esc(c.name)}</span><span class="nobudget">No budget set</span><span class="env-figs"><span class="left">${fmt0(spent)}</span><span class="of">spent</span></span></div>`;
        }
      }
      html += `</section>`;
    }
    if (anyBudget) html += `<div class="legend"><span><i class="track" style="width:28px;height:8px;display:inline-block;position:relative"><i class="fill" style="width:60%"></i></i>Spent so far</span>${pace > 0 && pace < 1 ? '<span><i style="width:2px;height:12px;background:var(--ink)"></i>Even pace for today</span><span><i style="width:12px;height:8px;background:#C9853A;border-radius:3px"></i>Ahead of pace</span>' : ''}</div>`;
    else if (T.count) html += `<p class="sub" style="margin-top:20px">Set monthly amounts on the <a href="#" data-go="budget">Budget</a> tab to see how much is left in each category.</p>`;

    const incomeCats = S.categories.filter(c => c.kind === 'income' && (T.byCat[c.id] || (!c.archived && budgetFor(c, S.month))));
    if (incomeCats.length) {
      html += `<section class="env-group"><h3>Money in <small>${fmt0(T.income)}${expectedIn ? ' of ' + fmt0(expectedIn) : ''}</small></h3>`;
      for (const c of incomeCats) {
        const got = T.byCat[c.id] || 0; const exp = budgetFor(c, S.month);
        if (exp) {
          const pct = Math.max(0, Math.min(1, got / exp)); const diff = exp - got;
          html += `<div class="env" data-cat="${esc(c.id)}" title="See ${esc(c.name)} transactions">
            <span class="env-name">${esc(c.name)}</span>
            <div class="track"><div class="fill inc" style="width:${(pct * 100).toFixed(1)}%"></div></div>
            <span class="env-figs"><span class="left">${diff > 0.5 ? fmt0(diff) + ' to come' : diff < -0.5 ? fmt0(-diff) + ' extra' : 'All in'}</span><span class="of">${fmt0(got)} of ${fmt0(exp)}</span></span>
          </div>`;
        } else {
          html += `<div class="env" data-cat="${esc(c.id)}"><span class="env-name">${esc(c.name)}</span><span class="nobudget">No amount expected</span><span class="env-figs"><span class="left in">${fmt0(got)}</span><span class="of">received</span></span></div>`;
        }
      }
      html += `</section>`;
    }
    return html;
  }

  // Transactions
  function filteredTx() {
    const f = S.filter; const q = f.q.trim().toUpperCase();
    return S.transactions.filter(t =>
      (f.allMonths || t.date.startsWith(S.month)) &&
      (!f.account || t.account === f.account) &&
      (!f.cat || (f.cat === '__none' ? !catById(t.category_id) : t.category_id === f.cat)) &&
      (!q || P.normDesc(t.description).includes(q) || P.prettyDesc(t.description).toUpperCase().includes(q) || (t.note || '').toUpperCase().includes(q) || String(Math.abs(t.amount)).includes(q))
    ).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  }
  function transactions() {
    const f = S.filter; const list = filteredTx();
    const total = list.reduce((s, t) => s + t.amount, 0);
    let html = `<h2>Transactions</h2>
      <p class="sub">${list.length} shown, net ${fmt(total)}. Pick a category and, if you like, have the ledger remember it for that store.</p>
      <div class="filters">
        <input type="search" id="fq" placeholder="Search payee, note, or amount" value="${esc(f.q)}">
        <select id="facct"><option value="">Both accounts</option>${Object.entries(ACCOUNTS).map(([id, a]) => `<option value="${id}" ${f.account === id ? 'selected' : ''}>${a.name}</option>`).join('')}</select>
        <select id="fcat"><option value="">All categories</option><option value="__none" ${f.cat === '__none' ? 'selected' : ''}>Needs a category</option>${catOptions(f.cat, { blank: '', includeArchived: true }).replace('<option value=""></option>', '')}</select>
      </div>
      <div class="row" style="margin-bottom:12px">
        <label class="small"><input type="checkbox" id="fall" ${f.allMonths ? 'checked' : ''}> Search every month</label>
        <span style="flex:1"></span>
        <button class="btn quiet" id="rerun">Apply rules to uncategorized</button>
      </div>`;
    if (!list.length) return html + `<div class="txlist"><div class="daygap">Nothing matches. ${S.transactions.length ? 'Try another month or clear the filters.' : '<a href="#" data-go="import">Import a statement</a> to get started.'}</div></div>`;
    html += `<div class="txlist">` + list.slice(0, 600).map(t => {
      const open = S.openTx === t.id;
      return `<div class="tx ${(ACCOUNTS[t.account] || {}).highlight ? 'tx-card' : ''}" data-id="${esc(t.id)}">
        <span class="tx-date">${shortDate(t.date)}${f.allMonths ? ' ' + t.date.slice(0, 4) : ''}</span>
        <button class="tx-payee" data-toggle aria-expanded="${open}">${esc(P.prettyDesc(t.description))}<span class="tx-acct">${esc((ACCOUNTS[t.account] || {}).name || t.account)}${t.note ? ', ' + esc(t.note) : ''}</span></button>
        <span class="money ${t.amount > 0 ? 'in' : ''}">${fmt(t.amount)}</span>
        <select data-setcat class="${catById(t.category_id) ? '' : 'empty'}" aria-label="Category">${catOptions(t.category_id)}</select>
        ${open ? `<div class="tx-more">
          <div>Bank description: <code>${esc(t.description)}</code></div>
          <div class="row"><input type="text" data-note placeholder="Add a note" value="${esc(t.note || '')}" style="flex:1">
          <button class="btn" data-savenote>Save note</button><button class="btn danger" data-deltx>Delete</button></div>
        </div>` : ''}
      </div>`;
    }).join('') + `</div>` + (list.length > 600 ? `<p class="small muted">Showing the first 600. Narrow the filters to see more.</p>` : '');
    return html;
  }

  // Import
  function importView() {
    const a = S.importAccount; const pv = S.preview;
    let html = `<h2>Import a statement</h2>
      <p class="sub">Paste or upload transactions from either account. Anything already in the ledger is skipped, so overlapping statements are fine.</p>
      <div class="steps">
        <div class="panel">
          <div class="row" style="margin-bottom:12px">
            <span class="seg" role="group" aria-label="Account">${Object.entries(ACCOUNTS).map(([id, x]) => `<button data-acct="${id}" aria-pressed="${a === id}">${x.name}</button>`).join('')}</span>
          </div>
          <details class="help">
            <summary>Best way to get ${a === 'wf' ? 'Wells Fargo' : 'Capital One'} transactions</summary>
            ${a === 'wf'
              ? `<ol><li>Sign in at wellsfargo.com on a computer and open your checking account.</li><li>Choose <b>Download Account Activity</b>, pick the dates, and choose <b>Comma Delimited</b>.</li><li>Upload that file below, or open it and paste the contents.</li></ol><p>You can also copy rows from a PDF statement or the activity page and paste them. The ledger will guess which rows are deposits; check the preview.</p>`
              : `<ol><li>Sign in at capitalone.com and open the card.</li><li>Choose <b>View Statements / Transactions</b>, then <b>Download Transactions</b> and pick <b>CSV</b>.</li><li>Upload that file below, or open it and paste the contents.</li></ol><p>Pasting rows copied from a PDF statement also works.</p>`}
          </details>
          <div style="margin-top:12px"><textarea id="paste" placeholder="Paste CSV or statement rows here">${esc(S.pasteText || '')}</textarea></div>
          <div class="row" style="margin-top:10px">
            <button class="btn primary" id="readBtn">Read transactions</button>
            <label class="btn" for="file">Upload CSV file</label><input id="file" type="file" accept=".csv,.txt,text/csv,text/plain" hidden>
            ${pv ? '<button class="btn quiet" id="clearPv">Start over</button>' : ''}
          </div>
        </div>`;
    if (pv) {
      const sel = pv.rows.filter(r => r.include);
      html += `<div class="panel">
        <div class="row" style="justify-content:space-between;margin-bottom:8px">
          <div><b>${pv.rows.length}</b> rows read as <b>${esc(pv.format)}</b> for ${esc(ACCOUNTS[pv.account].name)}.
          <span class="muted">${pv.rows.filter(r => r.status === 'dup').length} already in the ledger.</span></div>
          <div class="row"><button class="btn" id="flipAll">Flip all signs</button><button class="btn primary" id="doImport" ${sel.length ? '' : 'disabled'}>Import ${sel.length} transaction${sel.length === 1 ? '' : 's'}</button></div>
        </div>
        ${pv.warnings.map(w => `<p class="small" style="color:#8A5A1C;margin:4px 0">${esc(w)}</p>`).join('')}
        ${pv.rows.length ? `<div class="scroll"><table><thead><tr><th></th><th>Date</th><th>Payee</th><th class="num">Amount</th><th>Category</th><th>Status</th></tr></thead><tbody>
        ${pv.rows.map((r, i) => `<tr data-i="${i}">
          <td><input type="checkbox" data-inc ${r.include ? 'checked' : ''} ${r.status === 'dup' ? 'disabled' : ''} aria-label="Include"></td>
          <td class="small">${shortDate(r.date)}</td>
          <td>${esc(P.prettyDesc(r.description))}</td>
          <td class="num"><button class="flip money ${r.amount > 0 ? 'in' : ''}" data-flip title="Flip money in / out">${fmt(r.amount)}</button></td>
          <td><select data-pvcat aria-label="Category">${catOptions(r.category_id, { blank: 'Leave for later' })}</select></td>
          <td>${r.status === 'dup' ? '<span class="tag dup">Already in</span>' : r.status === 'maybe' ? '<span class="tag maybe" title="Same date, amount and account as one already in the ledger">Maybe a duplicate</span>' : '<span class="tag new">New</span>'}</td>
        </tr>`).join('')}</tbody></table></div>` : `<p class="muted">No transactions were found. Make sure each row has a date, a description and an amount.</p>`}
      </div>`;
    }
    return html + `</div>`;
  }

  function buildPreview(text) {
    const acct = S.importAccount; const type = ACCOUNTS[acct].type;
    const res = P.parseStatement(text, type);
    const rows = P.assignIds(res.txns, acct);
    const ids = new Set(S.transactions.map(t => t.id));
    const sig = new Set(S.transactions.map(t => `${t.account}|${t.date}|${(+t.amount).toFixed(2)}`));
    rows.forEach(r => {
      r.status = ids.has(r.id) ? 'dup' : sig.has(`${acct}|${r.date}|${r.amount.toFixed(2)}`) ? 'maybe' : 'new';
      r.include = r.status === 'new';
      r.category_id = autoCategory(r);
    });
    S.preview = { account: acct, format: res.format, warnings: res.warnings, rows };
  }
  function reidPreviewRow(r) { // amount changed -> id must change too
    const [fresh] = P.assignIds([{ date: r.date, description: r.description, amount: r.amount }], S.preview.account);
    r.id = fresh.id;
  }

  // Budget
  function budget() {
    const k = S.month;
    const prev = [1, 2, 3].map(n => monthTotals(shiftMonth(k, -n)));
    let html = `<h2>Budget for ${esc(monthLabel(k))}</h2>
      <p class="sub">The monthly amount carries into every month. Change "This month" when one month is different, like December gifts or a three-paycheck month.</p>`;
    const groups = {};
    S.categories.filter(c => !c.archived).forEach(c => (groups[c.grp] = groups[c.grp] || []).push(c));
    let totalB = 0, totalI = 0;
    for (const [g, cs] of Object.entries(groups)) {
      html += `<h3>${esc(g)}</h3><div class="scroll"><table class="bt"><thead><tr><th>Category</th><th>Group</th><th class="num">Monthly</th><th class="num">This month</th><th class="num">3-month avg</th><th></th></tr></thead><tbody>`;
      for (const c of cs) {
        const o = S.budgets.find(b => b.month === k && b.category_id === c.id);
        const avg = prev.reduce((s, t) => s + (t.byCat[c.id] || 0), 0) / 3;
        const shown = c.kind === 'expense' ? -avg : avg;
        if (c.kind === 'expense') totalB += budgetFor(c, k);
        if (c.kind === 'income') totalI += budgetFor(c, k);
        html += `<tr data-cid="${esc(c.id)}">
          <td><input type="text" data-f="name" value="${esc(c.name)}" aria-label="Category name"></td>
          <td><input type="text" data-f="grp" value="${esc(c.grp)}" aria-label="Group" list="grpList"></td>
          <td class="num">${c.kind !== 'transfer' ? `<input type="number" step="1" min="0" data-f="budget" value="${c.budget || ''}" placeholder="0" aria-label="${c.kind === 'income' ? 'Expected each month' : 'Monthly budget'}">` : '<span class="muted small">Not counted</span>'}</td>
          <td class="num">${c.kind !== 'transfer' ? `<input type="number" step="1" min="0" data-f="override" value="${o ? o.amount : ''}" placeholder="${c.budget || 0}" aria-label="This month only">` : ''}</td>
          <td class="num money muted">${shown ? fmt0(shown) : '—'}</td>
          <td><button class="btn quiet danger" data-archive title="Hide this category">Hide</button></td>
        </tr>`;
      }
      html += `</tbody></table></div>`;
    }
    html += `<datalist id="grpList">${[...new Set(S.categories.map(c => c.grp))].map(g => `<option value="${esc(g)}">`).join('')}</datalist>
      <div class="panel" style="margin-top:24px">
        <div class="plan-line">
          <div><span>Expected income</span><strong class="money in">${fmt0(totalI)}</strong></div>
          <div><span>Spending budget</span><strong class="money">${fmt0(totalB)}</strong></div>
          <div><span>${totalI - totalB >= 0 ? 'Planned left over' : 'Planned shortfall'}</span><strong class="money ${totalI - totalB < 0 ? 'over' : ''}">${fmt0(Math.abs(totalI - totalB))}</strong></div>
        </div>
        <p class="small muted" style="margin:6px 0 0">For ${esc(monthLabel(k))}, using "This month" amounts where you've set them.</p>
        <h3 style="margin-top:16px">Add a category</h3>
        <div class="row"><input type="text" id="ncName" placeholder="Name, like Lake cabin"><input type="text" id="ncGrp" placeholder="Group" list="grpList">
        <select id="ncKind"><option value="expense">Spending</option><option value="income">Income</option><option value="transfer">Not counted (moving money)</option></select>
        <button class="btn primary" id="ncAdd">Add category</button></div>
      </div>`;
    const hidden = S.categories.filter(c => c.archived);
    if (hidden.length) html += `<p class="small muted" style="margin-top:16px">Hidden: ${hidden.map(c => `${esc(c.name)} <a href="#" data-unarchive="${esc(c.id)}">show</a>`).join(', ')}</p>`;
    return html;
  }

  // Rules
  function rules() {
    const rs = [...S.rules].sort((a, b) => a.pattern.localeCompare(b.pattern));
    return `<h2>Rules</h2>
      <p class="sub">When a bank description contains the text on the left, new transactions get that category automatically. Longer, more specific text wins.</p>
      <div class="panel" style="margin-bottom:18px"><div class="row">
        <input type="text" id="nrPat" placeholder="Text to look for, like KWIK TRIP" style="flex:1">
        <select id="nrDir"><option value="any">Money in or out</option><option value="out">Money out only</option><option value="in">Money in only</option></select>
        <select id="nrCat">${catOptions('')}</select>
        <button class="btn primary" id="nrAdd">Add rule</button>
      </div></div>
      ${rs.length ? `<div class="scroll"><table><thead><tr><th>Description contains</th><th>Applies to</th><th>Category</th><th></th></tr></thead><tbody>
      ${rs.map(r => `<tr data-rid="${esc(r.id)}"><td><b>${esc(r.pattern)}</b></td><td class="small muted">${{ any: 'In or out', in: 'Money in', out: 'Money out' }[r.direction] || 'In or out'}</td>
        <td><select data-rcat aria-label="Category">${catOptions(r.category_id)}</select></td><td><button class="btn quiet danger" data-rdel>Delete</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No rules yet.</p>'}
      <div style="margin-top:18px"><button class="btn" id="rerun">Apply rules to uncategorized</button></div>`;
  }

  const afterRender = {
    transactions() { const q = $('#fq'); if (q && S._focusSearch) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); S._focusSearch = false; } },
  };

  // ---------- actions ----------
  async function setCategory(t, catId) {
    t.category_id = catId || null;
    render();
    await save('transactions', [txRow(t)]);
    if (!catId) return;
    const key = P.merchantKey(t.description);
    if (!key || ruleFor(t) === catId) return;
    const others = S.transactions.filter(x => x.id !== t.id && !catById(x.category_id) && (P.normDesc(x.description) + ' | ' + P.cleanDesc(x.description)).includes(key));
    const c = catById(catId);
    toast(`Always put <b>${esc(P.prettyDesc(key))}</b> in ${esc(c.name)}?${others.length ? ` ${others.length} more waiting.` : ''}`, [
      { label: 'Yes, remember', run: () => addRule(key, catId, t.amount > 0 ? 'in' : 'out') },
      { label: 'Not now', quiet: true, run: () => {} },
    ], 9000);
  }
  async function addRule(pattern, catId, direction = 'any') {
    pattern = pattern.trim().toUpperCase();
    if (!pattern || !catId) return toast('A rule needs some text and a category.');
    const r = { id: 'r' + P.cyrb53(pattern + '|' + direction + '|' + Date.now()), pattern, category_id: catId, direction };
    S.rules.push(r);
    await save('rules', [ruleRow(r)]);
    const n = await applyRules(true);
    toast(`Rule saved.${n ? ` ${n} transaction${n === 1 ? '' : 's'} sorted.` : ''}`);
  }
  async function applyRules(silent) {
    const changed = [];
    for (const t of S.transactions) {
      if (catById(t.category_id)) continue;
      const c = autoCategory(t);
      if (c) { t.category_id = c; changed.push(t); }
    }
    if (changed.length) await save('transactions', changed.map(txRow));
    render();
    if (!silent) toast(changed.length ? `${changed.length} transaction${changed.length === 1 ? '' : 's'} sorted.` : 'No uncategorized transactions match a rule.');
    return changed.length;
  }

  // ---------- events ----------
  document.addEventListener('click', async e => {
    const el = e.target.closest('button, a, .env, .env-link');
    if (!el) return;
    const tab = el.closest('#tabs') && el.dataset.tab;
    if (tab) { S.tab = tab; localStorage.setItem('hl_tab', tab); S.openTx = null; render(); window.scrollTo(0, 0); return; }
    if (el.id === 'prevMonth' || el.id === 'nextMonth') { S.month = shiftMonth(S.month, el.id === 'prevMonth' ? -1 : 1); render(); return; }
    if (el.dataset.go) { e.preventDefault(); S.tab = el.dataset.go; localStorage.setItem('hl_tab', S.tab); render(); return; }
    if (el.dataset.cardtx) { S.filter = { q: '', account: el.dataset.cardtx, cat: '', allMonths: false }; S.tab = 'transactions'; render(); window.scrollTo(0, 0); return; }
    if (el.dataset.anchoredit) { e.preventDefault(); const f = document.querySelector(`[data-anchorform="${el.dataset.anchoredit}"]`); f.hidden = !f.hidden; if (!f.hidden) f.querySelector('input').focus(); return; }
    if (el.hasAttribute('data-uncat')) { S.filter = { q: '', account: '', cat: '__none', allMonths: false }; S.tab = 'transactions'; render(); return; }
    if (el.dataset.cat) { S.filter = { q: '', account: '', cat: el.dataset.cat, allMonths: false }; S.tab = 'transactions'; render(); window.scrollTo(0, 0); return; }

    // transactions
    const txEl = el.closest('.tx');
    if (txEl) {
      const t = S.transactions.find(x => x.id === txEl.dataset.id);
      if (el.hasAttribute('data-toggle')) { S.openTx = S.openTx === t.id ? null : t.id; render(); return; }
      if (el.hasAttribute('data-savenote')) { t.note = txEl.querySelector('[data-note]').value.trim(); S.openTx = null; render(); await save('transactions', [txRow(t)]); toast('Note saved.'); return; }
      if (el.hasAttribute('data-deltx')) {
        S.transactions = S.transactions.filter(x => x.id !== t.id); S.openTx = null; render();
        await del('transactions', [t.id]);
        toast('Transaction deleted.', [{ label: 'Undo', run: async () => { S.transactions.push(t); render(); await save('transactions', [txRow(t)]); } }]);
        return;
      }
    }
    if (el.id === 'rerun') { el.disabled = true; await applyRules(false); return; }

    // import
    if (el.dataset.acct) { S.importAccount = el.dataset.acct; S.pasteText = $('#paste').value; S.preview = null; render(); return; }
    if (el.id === 'readBtn') {
      S.pasteText = $('#paste').value;
      if (!S.pasteText.trim()) return toast('Paste some transactions first, or upload a CSV file.');
      buildPreview(S.pasteText); render(); return;
    }
    if (el.id === 'clearPv') { S.preview = null; S.pasteText = ''; render(); return; }
    if (el.id === 'flipAll') { S.preview.rows.forEach(r => { r.amount = -r.amount; reidPreviewRow(r); r.category_id = autoCategory(r); }); render(); return; }
    if (el.hasAttribute('data-flip')) { const r = S.preview.rows[+el.closest('tr').dataset.i]; r.amount = -r.amount; reidPreviewRow(r); render(); return; }
    if (el.id === 'doImport') {
      const rows = S.preview.rows.filter(r => r.include).map(r => txRow({ ...r, account: S.preview.account, note: '' }));
      el.disabled = true; el.textContent = 'Importing…';
      try { await save('transactions', rows, { ignoreDuplicates: true }); } catch { el.disabled = false; el.textContent = 'Try again'; return; }
      const have = new Set(S.transactions.map(t => t.id));
      rows.forEach(r => { if (!have.has(r.id)) S.transactions.push(r); });
      const months = rows.map(r => r.date.slice(0, 7)).sort();
      const unc = rows.filter(r => !r.category_id).length;
      S.preview = null; S.pasteText = '';
      if (months.length) S.month = months[months.length - 1];
      S.filter = { q: '', account: '', cat: unc ? '__none' : '', allMonths: false };
      S.tab = 'transactions'; render();
      toast(`Imported ${rows.length} transaction${rows.length === 1 ? '' : 's'}.${unc ? ` ${unc} need a category.` : ''}`);
      return;
    }

    // budget
    if (el.hasAttribute('data-archive')) {
      const c = catById(el.closest('tr').dataset.cid); c.archived = true; render(); await save('categories', [catRow(c)]);
      toast(`${esc(c.name)} hidden.`, [{ label: 'Undo', run: async () => { c.archived = false; render(); await save('categories', [catRow(c)]); } }]); return;
    }
    if (el.dataset.unarchive) { e.preventDefault(); const c = catById(el.dataset.unarchive); c.archived = false; render(); await save('categories', [catRow(c)]); return; }
    if (el.id === 'ncAdd') {
      const name = $('#ncName').value.trim(); if (!name) return toast('Give the category a name.');
      let id = slug(name); while (catById(id)) id += '-2';
      const c = { id, name, grp: $('#ncGrp').value.trim() || 'Other', kind: $('#ncKind').value, budget: 0, sort: Math.max(0, ...S.categories.map(x => x.sort || 0)) + 1, archived: false };
      S.categories.push(c); render(); await save('categories', [catRow(c)]); toast(`${esc(name)} added.`); return;
    }

    // rules
    if (el.id === 'nrAdd') { await addRule($('#nrPat').value, $('#nrCat').value, $('#nrDir').value); return; }
    if (el.hasAttribute('data-rdel')) {
      const id = el.closest('tr').dataset.rid; const r = S.rules.find(x => x.id === id);
      S.rules = S.rules.filter(x => x.id !== id); render(); await del('rules', [id]);
      toast('Rule deleted.', [{ label: 'Undo', run: async () => { S.rules.push(r); render(); await save('rules', [ruleRow(r)]); } }]); return;
    }
  });

  document.addEventListener('change', async e => {
    const el = e.target;
    if (el.hasAttribute('data-setcat')) { const t = S.transactions.find(x => x.id === el.closest('.tx').dataset.id); await setCategory(t, el.value); return; }
    if (el.id === 'facct') { S.filter.account = el.value; render(); return; }
    if (el.id === 'fcat') { S.filter.cat = el.value; render(); return; }
    if (el.id === 'fall') { S.filter.allMonths = el.checked; render(); return; }
    if (el.id === 'file') {
      const f = el.files[0]; if (!f) return;
      S.pasteText = await f.text(); buildPreview(S.pasteText); render(); return;
    }
    if (el.hasAttribute('data-inc')) { S.preview.rows[+el.closest('tr').dataset.i].include = el.checked; render(); return; }
    if (el.hasAttribute('data-pvcat')) { S.preview.rows[+el.closest('tr').dataset.i].category_id = el.value || null; return; }
    if (el.hasAttribute('data-rcat')) { const r = S.rules.find(x => x.id === el.closest('tr').dataset.rid); r.category_id = el.value; await save('rules', [ruleRow(r)]); toast('Rule updated.'); return; }
    const tr = el.closest('tr[data-cid]');
    if (tr && el.dataset.f) {
      const c = catById(tr.dataset.cid); const f = el.dataset.f;
      if (f === 'override') {
        const id = S.month + '|' + c.id;
        const v = el.value.trim();
        S.budgets = S.budgets.filter(b => b.id !== id);
        if (v === '') await del('budgets', [id]);
        else { const b = { id, month: S.month, category_id: c.id, amount: +v || 0 }; S.budgets.push(b); await save('budgets', [b]); }
      } else {
        c[f] = f === 'budget' ? (+el.value || 0) : el.value.trim() || c[f];
        await save('categories', [catRow(c)]);
      }
      render();
      toast('Saved.', [], 1500);
    }
  });

  document.addEventListener('submit', async e => {
    const f = e.target.closest('[data-anchorform]');
    if (!f) return;
    e.preventDefault();
    const acct = f.dataset.anchorform;
    const v = { balance: Math.round(parseFloat(f.bal.value) * 100) / 100, date: f.date.value };
    if (isNaN(v.balance) || !v.date) return toast('Enter the balance and the date it was shown.');
    S.settings['card-balance:' + acct] = v; render();
    await save('settings', [{ id: 'card-balance:' + acct, value: JSON.stringify(v) }]);
    toast('Card balance saved.');
  });

  let qTimer;
  document.addEventListener('input', e => {
    if (e.target.id === 'fq') { clearTimeout(qTimer); qTimer = setTimeout(() => { S.filter.q = e.target.value; S._focusSearch = true; render(); }, 200); }
  });

  // ---------- login ----------
  function logout() { localStorage.removeItem('hl_pass'); S.pass = ''; $('#app').hidden = true; $('#login').hidden = false; }
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    S.pass = $('#pass').value; $('#loginErr').hidden = true;
    try { await api({ action: 'ping' }); localStorage.setItem('hl_pass', S.pass); await start(); }
    catch (err) { $('#login').hidden = false; $('#loginErr').textContent = err.message === 'Wrong passcode' ? 'That passcode didn\'t work. Try again.' : err.message; $('#loginErr').hidden = false; }
  });

  async function start() {
    $('#login').hidden = true; $('#app').hidden = false;
    $('#view').innerHTML = '<p class="muted">Loading the ledger…</p>';
    try { await loadAll(); render(); }
    catch (e) { if (S.pass) $('#view').innerHTML = `<h2>Couldn't load the ledger</h2><p class="sub">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Try again</button>`; }
  }

  if (S.pass) start(); else { $('#login').hidden = false; $('#pass').focus(); }
})();
