-- Sanjeevani Care Hospitals (Demo · Healthcare) hospital information system.
-- SYNTHETIC ONLY: every value is generated here and belongs to nobody.
-- Accounts are created by scripts/local-demo-databases.py, which supplies
-- their passwords over stdin; no secret is in this file. MySQL 8.4.
create database his character set utf8mb4 collate utf8mb4_0900_ai_ci;
use his;
set session cte_max_recursion_depth = 1000;

create table wards (
  id int auto_increment primary key,
  ward_name varchar(60) not null,
  floor int not null
);
insert into wards (ward_name, floor)
with recursive seq(n) as (select 1 union all select n + 1 from seq where n < 12)
select concat(elt(1 + n % 4, 'General', 'Paediatric', 'Cardiac', 'Maternity'), ' ', n), 1 + n % 6 from seq;

create table patients (
  id int auto_increment primary key,
  full_name varchar(120) not null,
  email varchar(160) not null,
  phone varchar(20) not null,
  date_of_birth date not null,
  blood_group varchar(4) not null,
  aadhaar_number varchar(14) not null,
  address varchar(200) not null,
  ward_id int not null
);
insert into patients (full_name, email, phone, date_of_birth, blood_group, aadhaar_number, address, ward_id)
with recursive seq(n) as (select 1 union all select n + 1 from seq where n < 260)
select concat(f, ' ', l),
       concat(lower(f), '.', lower(l), n, '@example.in'),
       concat(6 + n % 4, lpad((n * 7919) % 1000000000, 9, '0')),
       date_add('1950-01-01', interval (n * 131) % 26000 day),
       elt(1 + n % 8, 'A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'),
       concat(2 + n % 8, lpad((n * 104729) % 100000000000, 11, '0')),
       concat(n % 250 + 1, ', Synthetic Road, Ward ', n % 30 + 1),
       1 + n % 12
from (select n,
        elt(1 + n % 20, 'Aarav', 'Diya', 'Vihaan', 'Ananya', 'Ishaan', 'Myra', 'Kabir', 'Saanvi',
          'Reyansh', 'Aadhya', 'Arjun', 'Kiara', 'Vivaan', 'Anika', 'Rohan', 'Meera', 'Advik',
          'Tara', 'Dhruv', 'Navya') as f,
        elt(1 + (n * 7) % 20, 'Sharma', 'Iyer', 'Patel', 'Reddy', 'Nair', 'Gupta', 'Kulkarni',
          'Das', 'Menon', 'Joshi', 'Rao', 'Singh', 'Bose', 'Khan', 'Pillai', 'Mehta', 'Shetty',
          'Chopra', 'Desai', 'Banerjee') as l
      from seq) names;

-- Guardians of minor patients: the children's-data case.
create table guardians (
  id int auto_increment primary key,
  patient_id int not null,
  guardian_name varchar(120) not null,
  relationship varchar(20) not null,
  child_dob date not null,
  guardian_phone varchar(20) not null
);
insert into guardians (patient_id, guardian_name, relationship, child_dob, guardian_phone)
with recursive seq(n) as (select 1 union all select n + 1 from seq where n < 60)
select n * 4, concat('Guardian ', n), elt(1 + n % 3, 'mother', 'father', 'legal guardian'),
       date_add('2012-01-01', interval n * 41 day), concat(9, lpad((n * 3571) % 1000000000, 9, '0'))
from seq;

create table diagnoses (
  id int auto_increment primary key,
  patient_id int not null,
  diagnosis_code varchar(10) not null,
  diagnosis_notes varchar(200) not null,
  recorded_on date not null
);
insert into diagnoses (patient_id, diagnosis_code, diagnosis_notes, recorded_on)
with recursive seq(n) as (select 1 union all select n + 1 from seq where n < 400)
select 1 + n % 260, elt(1 + n % 6, 'E11.9', 'I10', 'J45.9', 'K21.9', 'M54.5', 'O80'),
       elt(1 + n % 3, 'Stable, review in 3 months', 'Medication adjusted', 'Referred to specialist'),
       date_add('2025-01-01', interval n day)
from seq;

create table prescriptions (
  id int auto_increment primary key,
  patient_id int not null,
  medicine varchar(80) not null,
  dosage varchar(40) not null,
  prescription_text varchar(200) not null
);
insert into prescriptions (patient_id, medicine, dosage, prescription_text)
with recursive seq(n) as (select 1 union all select n + 1 from seq where n < 300)
select 1 + (n * 3) % 260, elt(1 + n % 5, 'Metformin', 'Amlodipine', 'Salbutamol', 'Pantoprazole', 'Paracetamol'),
       elt(1 + n % 3, '1-0-1', '0-0-1', 'as needed'), 'Take after food'
from seq;

create table staff (
  id int auto_increment primary key,
  employee_id varchar(12) not null,
  full_name varchar(120) not null,
  designation varchar(60) not null,
  department varchar(60) not null,
  salary decimal(12, 2) not null
);
insert into staff (employee_id, full_name, designation, department, salary)
with recursive seq(n) as (select 1 union all select n + 1 from seq where n < 80)
select concat('SCH', lpad(n, 5, '0')), concat('Staff Member ', n),
       elt(1 + n % 4, 'Nurse', 'Resident', 'Consultant', 'Technician'),
       elt(1 + n % 4, 'Cardiology', 'Paediatrics', 'Emergency', 'Radiology'), 30000 + n * 1100
from seq;

-- Front-desk free text: some notes carry phone numbers and email addresses.
create table appointment_notes (
  id int auto_increment primary key,
  patient_id int not null,
  notes varchar(240) not null
);
insert into appointment_notes (patient_id, notes)
with recursive seq(n) as (select 1 union all select n + 1 from seq where n < 180)
select 1 + n % 260,
       case n % 4
         when 0 then concat(8, lpad((n * 6151) % 1000000000, 9, '0'))
         when 1 then concat('family', n, '@example.in')
         else 'Follow-up booked at reception' end
from seq;

analyze table wards, patients, guardians, diagnoses, prescriptions, staff, appointment_notes;
