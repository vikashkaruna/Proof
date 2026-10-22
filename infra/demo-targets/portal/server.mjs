// Synthetic signed-in customer portals for the three demo companies. LOCAL
// ONLY: every page and value is invented here. One process serves three sites
// chosen by Host header; each has a login and a deliberately different set of
// privacy features so the signed-in website connector has something to find.
// Credentials come from a protected file mounted read-only; sessions live in
// memory. The access log records method, host and path only.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const USERS = JSON.parse(readFileSync(process.env.PORTAL_USERS_FILE ?? '/run/axiom/portal-users.json', 'utf8'));
const sessions = new Map();

const layout = (company, body, nav = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${company.name} — customer portal</title></head><body><header><strong>${company.name}</strong>
<nav>${nav}</nav></header><main>${body}</main><footer>Synthetic demonstration portal. No real data.</footer></body></html>`;

const SITES = {
  'axiom-portal-kosha': {
    name: 'Kosha Capital Finance',
    nav: `<a href="/account">My account</a> <a href="/statements/48213">Statements</a>
      <a href="/privacy">Privacy notice</a> <a href="/consent-settings">Consent preferences</a>
      <a href="/data-request">Download my data</a> <a href="/grievance">Grievance officer</a>
      <a href="/account/delete">Delete my account</a> <a href="/logout">Log out</a>`,
    pages: {
      '/account': `<h1>Welcome back, Aarav Sharma</h1>
        <form method="post" action="/account"><p>We use these details for the purpose of KYC verification
        under RBI rules. See our <a href="/privacy">privacy notice</a>.</p>
        <label>Full name <input name="full_name" value="Aarav Sharma"></label>
        <label>Email <input name="email" value="aarav.sharma@example.in"></label>
        <label>Mobile <input name="mobile" value="9123456780"></label>
        <label>PAN <input name="pan_no" value="ABCPS1234K"></label>
        <label><input type="checkbox" name="kyc_consent"> I consent to KYC verification</label>
        <button>Save</button></form>`,
      '/statements/48213': '<h1>Statement</h1><p>Account ending 0042. Balance shown in your app.</p>',
      '/privacy': '<h1>Privacy notice</h1><p>What we collect and why.</p><a href="/grievance">Contact our grievance officer</a>',
      '/consent-settings': `<h1>Consent preferences</h1><form method="post"><p>Withdraw consent at any time.
        We use this for the purpose of product updates.</p>
        <label><input type="checkbox" name="marketing_consent" checked> Product offers</label></form>`,
      '/data-request': '<h1>Request your data</h1><p>We will email a summary within 30 days.</p>',
      '/grievance': '<h1>Grievance redressal</h1><p>Write to the grievance officer.</p>',
    },
  },
  'axiom-portal-sanjeevani': {
    name: 'Sanjeevani Care Hospitals',
    nav: `<a href="/account">My profile</a> <a href="/family">Family members</a>
      <a href="/appointments/7721">Appointments</a> <a href="/privacy">Privacy policy</a>
      <a href="/grievance">Patient grievance cell</a> <a href="/logout">Sign out</a>`,
    pages: {
      '/account': `<h1>Patient profile — Diya Iyer</h1><form method="post" action="/account">
        <label>Name <input name="full_name" value="Diya Iyer"></label>
        <label>Phone <input name="phone" value="9988776655"></label>
        <label>Date of birth <input name="date_of_birth" value="1990-04-12"></label>
        <label>Aadhaar <input name="aadhaar_number" value="234567890123"></label>
        <label>Blood group <input name="blood_group" value="B+"></label>
        <label>Allergies <textarea name="allergy_notes">Penicillin</textarea></label>
        <button>Update</button></form>`,
      '/family': `<h1>Add a family member</h1><form method="post" action="/family">
        <label>Child's name <input name="child_name"></label>
        <label>Child's date of birth <input name="child_dob"></label>
        <label>Guardian name <input name="guardian_name"></label>
        <button>Add dependant</button></form>`,
      '/appointments/7721': '<h1>Appointment</h1><p>Cardiology OPD, Tuesday.</p>',
      '/privacy': '<h1>Privacy policy</h1><p>How we use patient information.</p>',
      '/grievance': '<h1>Patient grievance cell</h1><p>Raise a concern with the grievance officer.</p>',
    },
  },
  'axiom-portal-nimbus': {
    name: 'Nimbus Stack Technologies',
    // Sets a marketing cookie on the anonymous visit, before any consent.
    anonymousCookie: 'mkt_ref=campaign-q4; Path=/',
    nav: `<a href="/account">Account</a> <a href="/billing">Billing</a>
      <a href="/preferences">Communication preferences</a> <a href="/export-data">Export my data</a>
      <a href="/settings/close-account">Close account</a> <a href="/logout">Log out</a>`,
    pages: {
      '/account': `<h1>Hi Kabir</h1><form method="post" action="/account">
        <label>Full name <input name="full_name" value="Kabir Nair"></label>
        <label>Work email <input name="email" value="kabir.nair@example.in"></label>
        <label>Mobile <input name="mobile" value="9871203456"></label>
        <button>Save</button></form>`,
      '/billing': `<h1>Billing</h1><form method="post" action="/billing">
        <p>Billing details are used for the purpose of invoicing and GST compliance.</p>
        <label>UPI ID <input name="upi_id" value="kabir@okdemo"></label>
        <label>Billing address <input name="billing_address" value="12 Synthetic Tech Park"></label>
        <label>Company PAN <input name="company_pan" value="AAACN1234C"></label>
        <button>Save</button></form>`,
      '/preferences': `<h1>Communication preferences</h1><form method="post">
        <label><input type="checkbox" name="newsletter_consent"> Product newsletter</label></form>`,
      '/export-data': '<h1>Export your data</h1><p>Download a copy of your workspace data.</p>',
    },
  },
};

function equal(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
function cookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

createServer(async (req, res) => {
  const host = (req.headers.host ?? '').split(':')[0];
  const site = SITES[host];
  const url = new URL(req.url ?? '/', 'http://portal.local');
  console.log(`${req.method} ${host} ${url.pathname}`);
  if (!site) {
    res.writeHead(404);
    return res.end('unknown site');
  }
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  };
  const user = USERS[host];
  const sid = cookie(req, 'portal_sid');
  const session = sid && sessions.get(sid);
  if (url.pathname === '/health') return send(200, 'ok');
  if (url.pathname === '/login' && req.method === 'GET') {
    const csrf = randomBytes(12).toString('hex');
    sessions.set(`csrf:${csrf}`, { host, at: Date.now() });
    return send(
      200,
      layout(site, `<h1>Sign in</h1><form method="post" action="/login">
        <input type="hidden" name="csrf" value="${csrf}">
        <label>Email <input name="email" type="email"></label>
        <label>Password <input name="password" type="password"></label><button>Sign in</button></form>`),
      site.anonymousCookie ? { 'set-cookie': [site.anonymousCookie] } : {},
    );
  }
  if (url.pathname === '/login' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    const csrf = sessions.get(`csrf:${form.get('csrf')}`);
    sessions.delete(`csrf:${form.get('csrf')}`);
    if (csrf?.host === host && user && equal(form.get('email'), user.username) && equal(form.get('password'), user.password)) {
      const token = randomBytes(24).toString('hex');
      sessions.set(token, { host, at: Date.now() });
      return send(303, '', { location: '/account', 'set-cookie': [`portal_sid=${token}; HttpOnly; SameSite=Lax; Path=/`] });
    }
    return send(401, layout(site, '<p>Sign-in failed.</p><a href="/login">Try again</a>'));
  }
  if (!session || session.host !== host) return send(302, '', { location: '/login' });
  if (url.pathname === '/logout') {
    sessions.delete(sid);
    return send(302, '', { location: '/login' });
  }
  const page = site.pages[url.pathname];
  if (!page) return send(404, layout(site, '<p>Not found.</p>', site.nav));
  return send(200, layout(site, page, site.nav));
}).listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
