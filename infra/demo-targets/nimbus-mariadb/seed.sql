-- Nimbus Stack Technologies (Demo · SaaS) application database. SYNTHETIC
-- ONLY: every value is generated here and belongs to nobody. Accounts are
-- created by scripts/local-demo-databases.py, which supplies their passwords
-- over stdin; no secret is in this file. MariaDB 11.4.
create database app character set utf8mb4 collate utf8mb4_unicode_ci;
use app;

create table plans (
  id int auto_increment primary key,
  plan_name varchar(40) not null,
  monthly_price decimal(10, 2) not null
);
insert into plans (plan_name, monthly_price) values ('Starter', 999), ('Team', 4999), ('Enterprise', 24999);

create table users (
  id int auto_increment primary key,
  full_name varchar(120) not null,
  email varchar(160) not null,
  mobile varchar(20) not null,
  date_of_birth date null,
  country varchar(40) not null,
  plan_id int not null
);
insert into users (full_name, email, mobile, date_of_birth, country, plan_id)
with recursive seq(n) as (select 1 union all select n + 1 from seq where n < 300)
select concat(f, ' ', l),
       concat(lower(f), '.', lower(l), n, '@example.in'),
       concat(6 + n % 4, lpad((n * 7919) % 1000000000, 9, '0')),
       if(n % 5 = 0, null, date_add('1975-01-01', interval (n * 53) % 12000 day)),
       elt(1 + n % 3, 'India', 'India', 'Singapore'),
       1 + n % 3
from (select n,
        elt(1 + n % 20, 'Aarav', 'Diya', 'Vihaan', 'Ananya', 'Ishaan', 'Myra', 'Kabir', 'Saanvi',
          'Reyansh', 'Aadhya', 'Arjun', 'Kiara', 'Vivaan', 'Anika', 'Rohan', 'Meera', 'Advik',
          'Tara', 'Dhruv', 'Navya') as f,
        elt(1 + (n * 7) % 20, 'Sharma', 'Iyer', 'Patel', 'Reddy', 'Nair', 'Gupta', 'Kulkarni',
          'Das', 'Menon', 'Joshi', 'Rao', 'Singh', 'Bose', 'Khan', 'Pillai', 'Mehta', 'Shetty',
          'Chopra', 'Desai', 'Banerjee') as l
      from seq) names;

-- Billing: masked card digits, UPI handles and GST identities.
create table billing_profiles (
  id int auto_increment primary key,
  user_id int not null,
  card_last4 char(4) not null,
  upi_id varchar(60) not null,
  billing_address varchar(200) not null,
  company_pan varchar(10) null
);
insert into billing_profiles (user_id, card_last4, upi_id, billing_address, company_pan)
with recursive seq(n) as (select 1 union all select n + 1 from seq where n < 220)
select n, lpad((n * 97) % 10000, 4, '0'), concat('user', n, '@okdemo'),
       concat(n % 200 + 1, ', Synthetic Tech Park, Bengaluru'),
       if(n % 4 = 0,
          concat(char(65 + n % 26), char(65 + (n * 3) % 26), char(65 + (n * 5) % 26), 'C',
                 char(65 + (n * 7) % 26), lpad((n * 37) % 10000, 4, '0'), char(65 + (n * 11) % 26)),
          null)
from seq;

create table marketing_consents (
  id int auto_increment primary key,
  user_id int not null,
  email_opt_in tinyint(1) not null,
  sms_opt_in tinyint(1) not null,
  consented_at datetime not null,
  consent_source varchar(40) not null
);
insert into marketing_consents (user_id, email_opt_in, sms_opt_in, consented_at, consent_source)
with recursive seq(n) as (select 1 union all select n + 1 from seq where n < 300)
select n, n % 3 <> 0, n % 4 = 0, date_add('2025-06-01', interval n hour),
       elt(1 + n % 3, 'signup form', 'settings page', 'imported list')
from seq;

-- Support tickets: free-text bodies sometimes carry emails and phone numbers.
create table support_tickets (
  id int auto_increment primary key,
  user_id int not null,
  subject varchar(120) not null,
  body varchar(400) not null
);
insert into support_tickets (user_id, subject, body)
with recursive seq(n) as (select 1 union all select n + 1 from seq where n < 200)
select 1 + n % 300, elt(1 + n % 3, 'Invoice query', 'Login issue', 'Feature request'),
       case n % 5
         when 0 then concat('reach.me', n, '@example.in')
         when 1 then concat(9, lpad((n * 2711) % 1000000000, 9, '0'))
         else 'Please check the dashboard export' end
from seq;

create table audit_logs (
  id int auto_increment primary key,
  user_id int not null,
  action varchar(40) not null,
  ip_address varchar(45) not null,
  logged_at datetime not null
);
insert into audit_logs (user_id, action, ip_address, logged_at)
with recursive seq(n) as (select 1 union all select n + 1 from seq where n < 500)
select 1 + n % 300, elt(1 + n % 4, 'login', 'export', 'invite', 'logout'),
       concat('10.20.', n % 250, '.', (n * 7) % 250), date_add('2026-09-01', interval n minute)
from seq;

analyze table plans, users, billing_profiles, marketing_consents, support_tickets, audit_logs;
