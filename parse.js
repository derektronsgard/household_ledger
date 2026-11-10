/* Statement parsing for Household Ledger.
   Works in the browser (window.Parse) and in Node (module.exports) for testing. */
(function (root) {
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

  // ---------- small helpers ----------
  function pad(n) { return String(n).padStart(2, '0'); }

  function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  // Resolve a month/day (and maybe year) into YYYY-MM-DD.
  // With no year, pick the most recent year that doesn't put the date in the future.
  function makeDate(m, d, y, today) {
    m = +m; d = +d;
    if (!m || !d || m > 12 || d > 31) return null;
    if (y) {
      y = +y;
      if (y < 100) y += 2000;
    } else {
      const t = today || new Date();
      y = t.getFullYear();
      const candidate = new Date(y, m - 1, d);
      const limit = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 5);
      if (candidate > limit) y -= 1;
    }
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  function parseDateCell(s, today) {
    s = String(s || '').trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return makeDate(m[2], m[3], m[1]);
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/))) return makeDate(m[1], m[2], m[3], today);
    if ((m = s.match(/^([A-Za-z]{3,4})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/))) {
      const mo = MONTHS[m[1].toLowerCase()];
      if (mo) return makeDate(mo, m[2], m[3], today);
    }
    return null;
  }

  function parseMoney(s) {
    if (s == null) return null;
    let t = String(s).trim();
    if (!t) return null;
    let neg = false;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    if (/^[-−–]/.test(t)) { neg = true; t = t.replace(/^[-−–]\s*/, ''); }
    if (/-$/.test(t)) { neg = true; t = t.slice(0, -1); }
    t = t.replace(/[$,\s]/g, '');
    if (!/^\d*\.?\d+$/.test(t)) return null;
    const v = parseFloat(t);
    return neg ? -v : v;
  }

  // ---------- CSV ----------
  function parseCSVRows(text) {
    const rows = []; let row = []; let cell = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ''));
  }

  function looksLikeCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 6);
    if (!lines.length) return false;
    const commaLines = lines.filter(l => (l.match(/,/g) || []).length >= 2).length;
    return commaLines >= Math.ceil(lines.length * 0.6);
  }

  function parseCSV(text, accountType, today) {
    const rows = parseCSVRows(text);
    const out = []; const warnings = [];
    if (!rows.length) return { format: 'CSV', txns: out, warnings };
    const head = rows[0].map(h => h.toLowerCase());
    const hasHeader = !parseDateCell(rows[0][0], today) && head.some(h => /date|description|amount|debit|credit/.test(h));
    let format = 'CSV';

    if (hasHeader) {
      const find = re => head.findIndex(h => re.test(h));
      let iDate = find(/transaction date|trans\.? date/);
      if (iDate < 0) iDate = find(/date/);
      const iDesc = find(/description|merchant|payee|name|memo/);
      const iAmt = find(/^amount$|amount/);
      const iDebit = find(/debit|withdraw/);
      const iCredit = find(/credit|deposit/);
      const iCat = head.findIndex(h => h === 'category');
      const iStatus = head.indexOf('status');
      if (head.includes('check #')) format = 'Wells Fargo CSV';
      else if (head.includes('card no.') || (iDebit >= 0 && iCredit >= 0 && head.some(h => h === 'posted date'))) format = 'Capital One CSV';
      else if (format === 'CSV') format = 'CSV with headers';
      if (iDate < 0 || iDesc < 0 || (iAmt < 0 && iDebit < 0 && iCredit < 0)) {
        warnings.push('Couldn\'t find date, description and amount columns in this CSV.');
        return { format, txns: out, warnings };
      }
      let pending = 0;
      for (const r of rows.slice(1)) {
        const date = parseDateCell(r[iDate], today);
        if (!date) continue;
        if (iStatus >= 0 && /pending/i.test(r[iStatus] || '')) { pending++; continue; }
        let amount;
        if (iDebit >= 0 || iCredit >= 0) {
          const d = parseMoney(r[iDebit]) || 0; const c = parseMoney(r[iCredit]) || 0;
          if (!d && !c && iAmt >= 0 && iAmt !== iDebit && iAmt !== iCredit) amount = parseMoney(r[iAmt]);
          else amount = Math.abs(c) - Math.abs(d); // money in positive, money out negative
        } else {
          amount = parseMoney(r[iAmt]);
          // A credit card export with a single positive "Amount" column means charges are positive.
          if (accountType === 'card' && amount != null) amount = -amount;
        }
        if (amount == null || amount === 0) continue;
        const tx = { date, description: r[iDesc] || '(no description)', amount: round2(amount) };
        if (iCat >= 0 && r[iCat]) tx.bankCategory = r[iCat];
        out.push(tx);
      }
      if (pending) warnings.push(`Skipped ${pending} pending transaction${pending === 1 ? '' : 's'}. ${pending === 1 ? 'It' : 'They'} can come in once posted, since the bank changes the description.`);
      if (iAmt >= 0 && iDebit < 0 && accountType === 'card') warnings.push('Treated positive amounts as card charges. Use "Flip signs" if spending shows as money in.');
    } else {
      // Wells Fargo "comma delimited" download: "Date","Amount","*","","Description" (no header)
      const wf = rows.filter(r => r.length >= 5 && parseDateCell(r[0], today) && parseMoney(r[1]) != null);
      if (wf.length >= rows.length * 0.6) {
        format = 'Wells Fargo CSV';
        for (const r of wf) {
          const amount = parseMoney(r[1]);
          if (!amount) continue;
          out.push({ date: parseDateCell(r[0], today), description: r[4] || r[3] || '(no description)', amount: round2(amount) });
        }
      } else {
        format = 'CSV (guessed columns)';
        for (const r of rows) {
          const di = r.findIndex(c => parseDateCell(c, today));
          if (di < 0) continue;
          const ai = r.findIndex((c, i) => i !== di && /\d\.\d{2}\)?$/.test(c) && parseMoney(c) != null);
          if (ai < 0) continue;
          const desc = r.filter((c, i) => i !== di && i !== ai && /[A-Za-z]{2}/.test(c)).sort((a, b) => b.length - a.length)[0] || '(no description)';
          let amount = parseMoney(r[ai]);
          if (accountType === 'card') amount = -amount;
          out.push({ date: parseDateCell(r[di], today), description: desc, amount: round2(amount) });
        }
        warnings.push('This CSV layout wasn\'t recognized, so columns were guessed. Check the preview.');
      }
    }
    return { format, txns: out, warnings };
  }

  // ---------- pasted statement text ----------
  const SKIP_LINE = /(beginning|ending|opening|closing|previous|new) balance|^total|totals?\b.*for this period|minimum payment|payment due|available credit|credit limit|daily balance summary|^page \d/i;
  const MONEY_IN_WORDS = /\b(deposit|payroll|dir dep|direct dep|refund|interest payment|interest paid|transfer from|zelle from|from .* transfer|reversal|cashback|cash back|credit\b|mobile deposit|edeposit|venmo cashout|tax ref|irs treas|ssa treas|dividend)/i;
  const CARD_CREDIT_WORDS = /\b(payment|pymt|autopay|thank you|credit|refund|return)\b/i;

  const RE_NUM_DATE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+/;
  const RE_MON_DATE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+/i;
  const RE_MONEY = /([-−–]\s?)?\(?\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}\)?(-)?/g;

  function takeDate(s, today) {
    let m = s.match(RE_NUM_DATE);
    if (m) return { date: makeDate(m[1], m[2], m[3], today), rest: s.slice(m[0].length) };
    m = s.match(RE_MON_DATE);
    if (m) return { date: makeDate(MONTHS[m[1].toLowerCase()], m[2], m[3], today), rest: s.slice(m[0].length) };
    return null;
  }

  function parseText(text, accountType, today) {
    const out = []; const warnings = [];
    let guessedSigns = 0;
    const lines = text.split(/\r?\n/).map(l => l.replace(/\t/g, '  ').trim()).filter(Boolean);
    for (const line of lines) {
      if (SKIP_LINE.test(line)) continue;
      const first = takeDate(line, today);
      if (!first || !first.date) continue;
      let rest = first.rest;
      const second = takeDate(rest, today); // posted date column, if present
      if (second && second.date) rest = second.rest;

      const monies = [...rest.matchAll(RE_MONEY)];
      if (!monies.length) continue;
      const firstMoney = monies[0];
      const description = rest.slice(0, firstMoney.index).replace(/\s{2,}/g, ' ').trim();
      if (!description || !/[A-Za-z]/.test(description)) continue;
      const raw = firstMoney[0];
      const explicitNeg = /^[-−–]|\(|-$/.test(raw.trim());
      const val = Math.abs(parseMoney(raw));
      if (!val) continue;

      let amount;
      if (accountType === 'card') {
        // Card statements list charges as plain amounts; credits/payments carry a minus sign.
        if (explicitNeg) amount = val;
        else if (CARD_CREDIT_WORDS.test(description) && /payment|pymt|autopay|thank you/i.test(description)) amount = val;
        else amount = -val;
      } else {
        if (explicitNeg) amount = -val;
        else if (/^\+/.test(raw)) amount = val;
        else { amount = MONEY_IN_WORDS.test(description) ? val : -val; guessedSigns++; }
      }
      out.push({ date: first.date, description, amount: round2(amount) });
    }
    if (guessedSigns) warnings.push(`Money in vs. money out was guessed from the description for ${guessedSigns} row${guessedSigns === 1 ? '' : 's'}. Tap an amount in the preview to flip it.`);
    return { format: 'Pasted statement text', txns: out, warnings };
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  // ---------- public entry ----------
  function parseStatement(text, accountType, today) {
    text = String(text || '').replace(/^﻿/, '');
    if (!text.trim()) return { format: 'Empty', txns: [], warnings: [] };
    const res = looksLikeCSV(text) ? parseCSV(text, accountType, today) : parseText(text, accountType, today);
    if (!res.txns.length && looksLikeCSV(text)) {
      const alt = parseText(text, accountType, today);
      if (alt.txns.length) return alt;
    }
    return res;
  }

  function normDesc(d) { return String(d || '').toUpperCase().replace(/\s+/g, ' ').trim(); }

  // Stable ids so re-importing an overlapping statement doesn't create duplicates.
  function assignIds(txns, account) {
    const seen = {};
    return txns.map(t => {
      const base = `${account}|${t.date}|${t.amount.toFixed(2)}|${normDesc(t.description)}`;
      seen[base] = (seen[base] || 0) + 1;
      return { ...t, account, id: 't' + cyrb53(base + '|' + seen[base]) };
    });
  }

  // Strip bank noise so "PURCHASE AUTHORIZED ON 11/03 CUB FOODS #1621 MOUND MN S386..." becomes "Cub Foods".
  function cleanDesc(d) {
    const raw = String(d || '').toUpperCase();
    let s = normDesc(d);
    if (/TARGET DEBIT CRD/.test(s)) return 'TARGET';
    let m = s.match(/^ATM (WITHDRAWAL|CHECK DEPOSIT|CASH DEPOSIT|DEPOSIT)/);
    if (m) return m[0];
    m = s.match(/^PAYPAL PURCHASE \d{6} (\S+(?: \S+)?)/);
    if (m) return m[1];
    // Wells Fargo card lines: "... AUTHORIZED ON 11/08 <merchant, 25 wide> <city, 13 wide> ST S123..."
    m = raw.match(/AUTHORIZED ON\s+\d{1,2}\/\d{1,2} (.{1,25})/);
    if (m) s = m[1].replace(/\s+/g, ' ').trim();
    // Wells Fargo ACH lines: "<company, 16 wide> <entry, 10 wide> 261109 ..."
    else if ((m = s.match(/^(.*?) (\d{6}|[A-Z]{3} \d{2}) \S/)) && /[A-Z]{3}/.test(m[1]) && !/TRANSFER/.test(m[1])) s = m[1];
    else if (/^[A-Z0-9].{15} \S/.test(raw) && /\S\s{2,}/.test(raw.slice(0, 30))) {
      s = (raw.slice(0, 16).trim() + ' ' + raw.slice(17, 27).trim()).replace(/\s+/g, ' ');
    }
    if (/^AMAZON (RETA|MARK|MKTPL)/.test(s)) return 'AMAZON';
    s = s.replace(/\b(REF\s?#.*|XXXX+\d+.*| ON \d{2}\/\d{2}\/\d{2}.*)$/, '');
    s = s.replace(/^(RECURRING )?(PURCHASE|PAYMENT|PURCHASE INTL|PURCHASE RETURN|NON-WF ATM WITHDRAWAL|MONEY TRANSFER) (AUTHORIZED|AUTHORIZED ON|ON)?\s*(ON )?\d{1,2}\/\d{1,2}\s*/, '');
    s = s.replace(/\b[SP]\d{9,}\b/g, ' ').replace(/\bCARD \d{4}\b/g, ' ').replace(/\b(REF|ID|CO ID|ENTRY|IND ID|INDN)[: #]*[A-Z0-9]+\b/g, ' ');
    s = s.replace(/^(SQ|TST|SP|PY|PPY|CTLP|DD|DK|BT|IN|PP|PAYPAL|GOOGLE|APPLE PAY)\s?\*\s?/, '');
    s = s.replace(/#\s?\d*/g, ' ').replace(/\bATM ID \d+/, ' ');
    s = s.replace(/\b(?![A-Z]{6})(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10,}\b/g, ' ');
    s = s.replace(/\bX{2,}[X\d]*\b/g, ' ').replace(/\b\d{5,}\b/g, ' ');
    s = s.replace(/\*/g, ' ').replace(/\s{2,}/g, ' ').replace(/[\s,-]+$/, '').trim();
    return s || normDesc(d);
  }

  // A short piece of the description that identifies the store, used when making a rule.
  function merchantKey(d) {
    const c = cleanDesc(d);
    if (/TRANSFER (FROM|TO) /.test(c)) return c; // keep "from which account" so savings and pay transfers stay separate
    const cw = cleanDesc(d).replace(/[,:]/g, ' ').split(' ').filter(w => /[A-Z]/.test(w) && !/\d{2}/.test(w));
    const weak = w => w.length < 3 || /^(THE|AND|OF|INC|LLC|CO|MN|US)$/.test(w);
    const n = cw.length > 2 && (weak(cw[0]) || weak(cw[1])) ? 3 : 2;
    return cw.slice(0, n).join(' ') || cleanDesc(d).slice(0, 16);
  }

  function prettyDesc(d) {
    return cleanDesc(d).replace(/\s\d{2,4}$/, '').replace(/[\s,-]+$/, '').toLowerCase().replace(/(^|[\s\-\/&(.])([a-z])/g, (m, a, c) => a + c.toUpperCase())
      .replace(/\b(Mn|Wi|Nd|Sd|Ia|Usa|Llc|Atm|Ach|Us)\b/g, w => w.toUpperCase());
  }

  // Credit card payments show up in both accounts; they're moving money, not spending.
  function isCardPayment(t, accountType) {
    const d = normDesc(t.description);
    if (accountType === 'card') return t.amount > 0 && /PAYMENT|PYMT|AUTOPAY/.test(d) && !/RETURN|REFUND/.test(d);
    return t.amount < 0 && /CAPITAL ONE|CAPITALONE/.test(d) && /PMT|PYMT|PAYMENT|AUTOPAY|CRCARDPMT|CARD PMT|ONLINE/.test(d);
  }
  function isTransfer(t) {
    return /ONLINE TRANSFER (TO|FROM)|RECURRING TRANSFER (TO|FROM)|TRANSFER (TO|FROM) (SAV|CHK|CHECKING|SAVINGS)|WAY2SAVE|SAVE AS YOU GO/.test(normDesc(t.description));
  }

  const api = { parseStatement, parseCSVRows, parseMoney, parseDateCell, assignIds, cleanDesc, merchantKey, prettyDesc, isCardPayment, isTransfer, normDesc, cyrb53 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Parse = api;
})(typeof window !== 'undefined' ? window : globalThis);
