-- Kosha Capital Finance (Demo · BFSI) core-banking database. SYNTHETIC ONLY:
-- every name, number and address is generated here; none belongs to a person.
-- Email domains use example.in; identifiers only have the right shape.
-- Login roles are created without passwords; scripts/local-demo-databases.py
-- sets them over stdin after start-up so no secret is in this file.
create schema core;

create table core.branches (
  id integer primary key generated always as identity,
  branch_code text not null unique,
  city text not null
);
insert into core.branches (branch_code, city)
select 'KOSHA' || lpad(n::text, 4, '0'),
       (array['Mumbai','Pune','Nagpur','Nashik','Thane','Aurangabad'])[1 + n % 6]
from generate_series(1, 18) n;

create table core.customers (
  id integer primary key generated always as identity,
  full_name text not null,
  email text not null,
  mobile text not null,
  pan_no text not null,
  aadhaar_number text not null,
  date_of_birth date not null,
  address text not null,
  pincode text not null,
  kyc_status text not null,
  branch_id integer not null references core.branches(id)
);
insert into core.customers (full_name, email, mobile, pan_no, aadhaar_number, date_of_birth,
  address, pincode, kyc_status, branch_id)
select f || ' ' || l,
       lower(f) || '.' || lower(l) || n || '@example.in',
       (6 + n % 4)::text || lpad(((n * 7919) % 1000000000)::text, 9, '0'),
       chr(65 + n % 26) || chr(65 + (n * 3) % 26) || chr(65 + (n * 5) % 26) || 'P'
         || chr(65 + (n * 7) % 26) || lpad(((n * 37) % 10000)::text, 4, '0') || chr(65 + (n * 11) % 26),
       (2 + n % 8)::text || lpad(((n * 104729) % 100000000000)::text, 11, '0'),
       date '1960-01-01' + (n * 97) % 15000,
       (n % 300 + 1) || ', Synthetic Lane, Sector ' || (n % 40 + 1),
       (400001 + n % 600)::text,
       (array['verified','pending','re-kyc due'])[1 + n % 3],
       1 + n % 18
from generate_series(1, 240) n,
     lateral (select (array['Aarav','Diya','Vihaan','Ananya','Ishaan','Myra','Kabir','Saanvi',
       'Reyansh','Aadhya','Arjun','Kiara','Vivaan','Anika','Rohan','Meera','Advik','Tara',
       'Dhruv','Navya'])[1 + n % 20] f,
       (array['Sharma','Iyer','Patel','Reddy','Nair','Gupta','Kulkarni','Das','Menon','Joshi',
       'Rao','Singh','Bose','Khan','Pillai','Mehta','Shetty','Chopra','Desai','Banerjee'])[1 + (n * 7) % 20] l) names;

create table core.accounts (
  id integer primary key generated always as identity,
  customer_id integer not null references core.customers(id),
  account_number text not null unique,
  ifsc text not null,
  account_type text not null,
  balance numeric(14, 2) not null,
  opened_on date not null
);
insert into core.accounts (customer_id, account_number, ifsc, account_type, balance, opened_on)
select 1 + n % 240, '9100' || lpad((n * 13)::text, 10, '0'), 'KOSH000' || lpad((n % 18 + 1)::text, 4, '0'),
       (array['savings','current','salary'])[1 + n % 3], (n * 1234.5) % 900000, date '2015-01-01' + n * 5
from generate_series(1, 320) n;

create table core.loans (
  id integer primary key generated always as identity,
  customer_id integer not null references core.customers(id),
  loan_type text not null,
  principal numeric(14, 2) not null,
  emi numeric(12, 2) not null,
  annual_income numeric(14, 2) not null,
  status text not null
);
insert into core.loans (customer_id, loan_type, principal, emi, annual_income, status)
select 1 + (n * 3) % 240, (array['home','personal','vehicle','gold'])[1 + n % 4], 100000 + n * 5000,
       2500 + n * 40, 300000 + n * 9000, (array['active','closed','overdue'])[1 + n % 3]
from generate_series(1, 120) n;

create table core.nominees (
  id integer primary key generated always as identity,
  account_id integer not null references core.accounts(id),
  nominee_name text not null,
  relationship text not null,
  nominee_is_minor boolean not null,
  guardian_name text
);
insert into core.nominees (account_id, nominee_name, relationship, nominee_is_minor, guardian_name)
select n, 'Nominee ' || n, (array['spouse','son','daughter','parent'])[1 + n % 4], n % 4 in (1, 2),
       case when n % 4 in (1, 2) then 'Guardian ' || n end
from generate_series(1, 200) n;

-- Free-text service notes: some hold contact numbers, the unstructured-PII case.
create table core.service_notes (
  id integer primary key generated always as identity,
  customer_id integer not null references core.customers(id),
  notes text not null
);
insert into core.service_notes (customer_id, notes)
select 1 + n % 240,
       case when n % 3 = 0 then (7 + n % 3)::text || lpad(((n * 4241) % 1000000000)::text, 9, '0')
            else 'Visited branch for passbook update' end
from generate_series(1, 150) n;

analyze;

-- Least-privilege discovery account: SELECT only, nothing else.
create role axiom_discovery_ro login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant usage on schema core to axiom_discovery_ro;
grant select on all tables in schema core to axiom_discovery_ro;
-- Deliberately over-privileged account for negative tests: the binding must refuse it.
create role axiom_overprivileged login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant usage on schema core to axiom_overprivileged;
grant select, insert on all tables in schema core to axiom_overprivileged;
