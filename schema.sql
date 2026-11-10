-- Household Ledger database setup.
-- Paste all of this into Supabase → SQL Editor → New query, then click Run.

create table if not exists categories (
  id        text primary key,
  name      text not null,
  grp       text not null default 'Other',
  kind      text not null default 'expense' check (kind in ('expense','income','transfer')),
  budget    numeric(12,2) not null default 0,   -- default monthly budget
  sort      int not null default 0,
  archived  boolean not null default false
);

create table if not exists transactions (
  id          text primary key,
  account     text not null,
  date        date not null,
  description text not null,
  amount      numeric(12,2) not null,           -- negative = money out, positive = money in
  category_id text,
  note        text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists transactions_date_idx on transactions (date);

create table if not exists rules (
  id          text primary key,
  pattern     text not null,                    -- text to look for in the description
  category_id text not null,
  direction   text not null default 'any' check (direction in ('any','in','out')),
  display_name text not null default '',        -- optional name to show, e.g. "Amazon"
  created_at  timestamptz not null default now()
);
alter table rules add column if not exists display_name text not null default '';

create table if not exists budgets (
  id          text primary key,                 -- "YYYY-MM|category_id"
  month       text not null,
  category_id text not null,
  amount      numeric(12,2) not null
);

create table if not exists settings (
  id    text primary key,                       -- e.g. "card-balance:c1"
  value text not null                           -- JSON
);

-- Lock the tables: only the app's server (using the secret key) can read or write.
alter table categories   enable row level security;
alter table transactions enable row level security;
alter table rules        enable row level security;
alter table budgets      enable row level security;
alter table settings     enable row level security;

-- Starter categories (rename, re-budget, or archive any of these in the app).
insert into categories (id, name, grp, kind, budget, sort) values
  ('paychecks',     'Paychecks',              'Income',         'income',   0, 10),
  ('other-income',  'Other income',           'Income',         'income',   0, 11),
  ('giving',        'Giving & tithe',         'Giving',         'expense',  0, 20),
  ('mortgage',      'Mortgage / rent',        'Home',           'expense',  0, 30),
  ('utilities',     'Utilities',              'Home',           'expense',  0, 31),
  ('phone-internet','Phone & internet',       'Home',           'expense',  0, 32),
  ('home-upkeep',   'Home upkeep',            'Home',           'expense',  0, 33),
  ('groceries',     'Groceries',              'Food',           'expense',  0, 40),
  ('dining',        'Dining out',             'Food',           'expense',  0, 41),
  ('coffee',        'Coffee',                 'Food',           'expense',  0, 42),
  ('gas',           'Gas',                    'Getting around', 'expense',  0, 50),
  ('auto',          'Car maintenance',        'Getting around', 'expense',  0, 51),
  ('insurance',     'Insurance',              'Bills',          'expense',  0, 60),
  ('subscriptions', 'Subscriptions',          'Bills',          'expense',  0, 61),
  ('fees',          'Interest & fees',        'Bills',          'expense',  0, 62),
  ('loans',         'Loans & other cards',    'Bills',          'expense',  0, 63),
  ('kids',          'Kids & school',          'Family',         'expense',  0, 70),
  ('health',        'Health & medical',       'Family',         'expense',  0, 71),
  ('personal',      'Personal care',          'Family',         'expense',  0, 72),
  ('pets',          'Pets',                   'Family',         'expense',  0, 73),
  ('shopping',      'Shopping',               'Fun & extras',   'expense',  0, 80),
  ('entertainment', 'Entertainment',          'Fun & extras',   'expense',  0, 81),
  ('hobbies',       'Hobbies',                'Fun & extras',   'expense',  0, 82),
  ('travel',        'Travel',                 'Fun & extras',   'expense',  0, 83),
  ('gifts',         'Gifts',                  'Fun & extras',   'expense',  0, 84),
  ('misc',          'Everything else',        'Other',          'expense',  0, 90),
  ('cc-payment',    'Credit card payment',    'Moving money',   'transfer', 0, 100),
  ('transfer',      'Transfer between accounts','Moving money', 'transfer', 0, 101)
on conflict (id) do nothing;

-- Starter rules for common Minnesota merchants. Edit or delete them in the Rules tab.
insert into rules (id, pattern, category_id, direction) values
  ('r-payroll',   'PAYROLL',          'paychecks',     'in'),
  ('r-dirdep',    'DIR DEP',          'paychecks',     'in'),
  ('r-cub',       'CUB FOODS',        'groceries',     'out'),
  ('r-lunds',     'LUNDS',            'groceries',     'out'),
  ('r-kowalski',  'KOWALSKI',         'groceries',     'out'),
  ('r-aldi',      'ALDI',             'groceries',     'out'),
  ('r-costco',    'COSTCO',           'groceries',     'out'),
  ('r-trader',    'TRADER JOE',       'groceries',     'out'),
  ('r-holiday',   'HOLIDAY STATION',  'gas',           'out'),
  ('r-kwik',      'KWIK TRIP',        'gas',           'out'),
  ('r-speedway',  'SPEEDWAY',         'gas',           'out'),
  ('r-caribou',   'CARIBOU',          'coffee',        'out'),
  ('r-starbucks', 'STARBUCKS',        'coffee',        'out'),
  ('r-xcel',      'XCEL ENERGY',      'utilities',     'out'),
  ('r-centerpt',  'CENTERPOINT',      'utilities',     'out'),
  ('r-netflix',   'NETFLIX',          'subscriptions', 'out'),
  ('r-spotify',   'SPOTIFY',          'subscriptions', 'out'),
  ('r-applebill', 'APPLE.COM/BILL',   'subscriptions', 'out'),
  ('r-amazon',    'AMAZON',           'shopping',      'out'),
  ('r-target',    'TARGET',           'shopping',      'out'),
  ('r-jubilee',   'JUBILEE FOODS',    'groceries',     'out'),
  ('r-casey',     'CASEYS',           'gas',           'out'),
  ('r-oasis',     'OASIS PUMP',       'gas',           'out'),
  ('r-cenex',     'CENEX',            'gas',           'out'),
  ('r-phillips',  'PHILLIPS 66',      'gas',           'out'),
  ('r-youtubetv', 'YOUTUBE',          'subscriptions', 'out'),
  ('r-peloton',   'PELOTON',          'subscriptions', 'out'),
  ('r-simplisafe','SIMPLISAFE',       'subscriptions', 'out'),
  ('r-natesilver','NATESILVER',       'subscriptions', 'out'),
  ('r-nyt',       'NYT',              'subscriptions', 'out'),
  ('r-interest',  'INTEREST CHARGE',  'fees',          'any'),
  ('r-latefee',   'PAST DUE FEE',     'fees',          'any'),
  ('r-statefarm', 'STATE FARM',       'insurance',     'out'),
  ('r-oreilly',   'O''REILLY',        'auto',          'out'),
  ('r-truevalue', 'TRUE VALUE',       'home-upkeep',   'out'),
  ('r-gscontrib', 'GOOD SHEPHERD LU CONTRIBUTN', 'giving', 'out'),
  ('r-mortgage',  'MORTGAGE SERV',    'mortgage',      'out'),
  ('r-mound',     'CITY OF MOUND',    'utilities',     'out'),
  ('r-invcloud',  'INVOICE CLOUD',    'utilities',     'out'),
  ('r-verizon',   'VERIZON',          'phone-internet','out'),
  ('r-studentln', 'DEPT EDUCATION',   'loans',         'out'),
  ('r-nsbank',    'NSBANK',           'loans',         'out'),
  ('r-synchrony', 'SYNCHRONY',        'loans',         'out'),
  ('r-1stbank',   '1ST BANKCARD',     'loans',         'out'),
  ('r-wfauto',    'WELLS FARGO AUTO', 'loans',         'out'),
  ('r-disney',    'DISNEY PLUS',      'subscriptions', 'out'),
  ('r-dazn',      'DAZN',             'subscriptions', 'out'),
  ('r-gamechgr',  'GAMECHANGER',      'subscriptions', 'out'),
  ('r-prime',     'AMAZON PRIME',     'subscriptions', 'out'),
  ('r-primevid',  'PRIME VIDEO',      'subscriptions', 'out'),
  ('r-greenlt',   'GREENLIGHT',       'kids',          'out'),
  ('r-dominos',   'DOMINO''S',        'dining',        'out'),
  ('r-jimmyj',    'JIMMY JOHNS',      'dining',        'out'),
  ('r-chickfila', 'CHICK-FIL-A',      'dining',        'out'),
  ('r-chipotle',  'CHIPOTLE',         'dining',        'out'),
  ('r-culvers',   'CULVERS',          'dining',        'out'),
  ('r-mcd',       'MCDONALD',         'dining',        'out'),
  ('r-pethosp',   'PETHOSPITAL',      'pets',          'out'),
  -- Derek's pay arrives as a transfer from his Everyday Checking account
  ('r-paytransfer','TRANSFER FROM TRONSGARD D EVERYDAY CHECKING', 'paychecks', 'in')
on conflict (id) do nothing;

-- Friendlier names for a few common stores.
update rules set display_name = 'Amazon'       where id = 'r-amazon'    and display_name = '';
update rules set display_name = 'Amazon Prime' where id = 'r-prime'     and display_name = '';
update rules set display_name = 'Target'       where id = 'r-target'    and display_name = '';
update rules set display_name = 'Kwik Trip'    where id = 'r-kwik'      and display_name = '';
update rules set display_name = 'Good Shepherd giving' where id = 'r-gscontrib' and display_name = '';
update rules set display_name = 'Mortgage'     where id = 'r-mortgage'  and display_name = '';
