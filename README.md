# Household Ledger

A family budget app for Wells Fargo checking and a Capital One card. Paste or upload statements, sort transactions into categories, and see how much is left in each budget category this month.

## What's in this folder

| File | What it does |
|---|---|
| `index.html` | The page and its styling |
| `app.js` | Everything the app does on screen |
| `parse.js` | Reads Wells Fargo and Capital One CSVs and pasted statement text |
| `api/db.js` | The server piece on Vercel: checks the family passcode and talks to the database |
| `schema.sql` | Creates the database tables, starter categories, and starter rules |

## Setup (about 15 minutes, one time)

### 1. Make the database (Supabase, free)
1. Go to supabase.com, sign in with GitHub, and click **New project**. Name it `household-ledger`, set a database password (you won't need it again), and pick a US region.
2. When it finishes, open **SQL Editor** → **New query**, paste everything in `schema.sql`, and click **Run**. You should see "Success."
3. Open **Project Settings** → **API Keys**. Copy two things somewhere handy:
   - the **Project URL** (looks like `https://abcdxyz.supabase.co`, also under Project Settings → Data API)
   - a **secret key** (starts with `sb_secret_`; click "Create new API key" → Secret if there isn't one). The older `service_role` key works too.

   Keep the secret key private. It only goes into Vercel, never into the code.

### 2. Put the code on GitHub
1. On github.com click **New repository**, name it `household-ledger`, and choose **Private**.
2. Click **uploading an existing file** and drag in everything from this folder, including the `api` folder. Commit.

### 3. Deploy on Vercel
1. In Vercel click **Add New → Project** and import `household-ledger`. Framework preset: **Other**. No build settings needed.
2. Open **Environment Variables** and add:
   - `FAMILY_PASSCODE` = the passcode you and your wife will type (a short phrase is better than a 4-digit PIN)
   - `SUPABASE_URL` = your Project URL
   - `SUPABASE_SECRET_KEY` = your secret key
3. Click **Deploy**. Open the site, type the passcode, and you're in. Each phone or computer remembers the passcode after the first time.

If you add or change an environment variable later, go to **Deployments → ⋯ → Redeploy** so it takes effect.

## Using it

**Import.** Pick Wells Fargo or Capital One, then upload the CSV or paste rows.
- Wells Fargo: wellsfargo.com → your checking account → *Download Account Activity* → *Comma Delimited*.
- Capital One: capitalone.com → your card → *View Statements / Transactions* → *Download Transactions* → *CSV*.
- Pasting rows copied from a PDF statement also works. For Wells Fargo text, the app guesses which rows are deposits; click any amount in the preview to flip it.

Re-importing an overlapping date range is safe: rows already in the ledger are skipped. Rows with the same date, amount, and account as an existing one are flagged "Maybe a duplicate" and left unchecked.

**Credit card payments** (the Wells Fargo payment to Capital One, and the matching credit on the card) are put in *Credit card payment*, which isn't counted as spending or income. That keeps the same money from being counted twice.

**Capital One card.** The Overview page has a card section for the month: what was charged, what was paid, and the amount to pay to bring the balance to $0. Enter the balance from the Capital One app once (with its date) so the number is exact; after that it stays current as you import. Capital One rows are marked with a purple stripe on the Transactions page.

**Paychecks that arrive as transfers.** Transfers between accounts normally don't count as income. A rule overrides that: the starter rule counts transfers in from Derek's Everyday Checking as Paychecks. If you mark another transfer as Paychecks, the app offers to remember that exact account.

**Categorize.** On Transactions, type in the category box (or click ▾ for the list). The app offers to make a rule for that store.

**Rules.** A rule says "descriptions containing *amazon* are Shopping, shown as *Amazon*." Rules apply to every transaction, past and future, and overwrite earlier categories (each change has an Undo). Capitals, spaces, and punctuation don't matter. The banks' own categories are ignored. Click a rule's match count to see exactly which transactions it covers.

**Budget.** Set a monthly amount per category. Use "This month" for one-off changes like December gifts. The 3-month average helps set realistic numbers.

**Overview.** Each category shows a bar of what's spent, and a tick mark for where you'd be at an even pace for today's date. Orange means ahead of pace; red means over budget. Tap a category to see its transactions.

## Update the database (one time, November 2026)
Rules gained a "Show as" name. If your database was set up before this, open Supabase → SQL Editor, run this line, and click Run:

```sql
alter table rules add column if not exists display_name text not null default '';
```

## Good to know
- Supabase's free tier pauses a project after about a week with no use. If the app says it can't load, open supabase.com and click **Restore project**.
- To change the passcode, edit `FAMILY_PASSCODE` in Vercel and redeploy. Everyone will be asked for the new one.
- To add another account (say, Wells Fargo savings), add a line to `ACCOUNTS` at the top of `app.js`, e.g. `wfs: { name: 'WF Savings', type: 'bank' },`.
