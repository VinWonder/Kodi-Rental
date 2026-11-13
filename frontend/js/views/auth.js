// Sign in, landlord registration + business onboarding, tenant invite acceptance.
import { api, adoptSession, login, reloadProfile, session } from '../api.js';
import { counties, field, house3d, icon, select } from '../components.js';
import { navigate } from '../router.js';
import { scopedMount } from '../shell.js';
import { setBusy, toast } from '../ui.js';

function authCard(inner, { wide = false } = {}) {
  document.body.classList.add('is-welcome');
  return `<section class="kodi-welcome">
    <div class="kodi-welcome-hero">
      <div class="kodi-stars"></div>
      <div class="kodi-welcome-brand">
        <a href="#/login" aria-label="Kodi home"><img src="/icons/icon-192.png" alt="" width="34" height="34" class="rounded-3"><span>Kodi</span></a>
        <a class="btn btn-glass btn-sm" href="#/vacancies">${icon('search', 16)} Find a house</a>
      </div>
      ${house3d('lg')}
      <div class="kodi-welcome-copy">
        <h2>Your home,<br><em>without the caretaker.</em></h2>
        <p>Rent by M-Pesa, instant receipts, repairs and a direct line to your landlord, all on your phone.</p>
        <ul class="kodi-welcome-points">
          <li>${icon('phone', 14)} M-Pesa rent</li><li>${icon('receipt', 14)} Instant receipts</li><li>${icon('wrench', 14)} Repairs tracked</li>
        </ul>
      </div>
    </div>
    <div class="kodi-welcome-side">
      <div class="kodi-welcome-sheet ${wide ? 'wide' : ''}">
        <div class="mb-4">${inner.heading}</div>
        ${inner.body}
      </div>
      <p class="kodi-welcome-foot"><a href="#/vacancies">${icon('search', 16)} Looking for a house? Browse vacancies</a></p>
    </div>
  </section>`;
}

function wireForm(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = form.querySelector('[data-error]');
    box.classList.add('d-none');
    if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
    const button = form.querySelector('[type=submit]');
    setBusy(button, true, 'Please wait…');
    try { await handler(new FormData(form)); } catch (err) {
      box.textContent = err.message;
      box.classList.remove('d-none');
    } finally { setBusy(button, false); }
  });
}

const errorSlot = '<div class="alert alert-danger small py-2 d-none" data-error role="alert"></div>';
const passwordField = (labelText = 'Password', autocomplete = 'current-password') => `
  <div class="mb-3"><label class="form-label small fw-semibold" for="pw">${labelText}</label>
    <div class="input-group"><input class="form-control form-control-lg" id="pw" name="password" type="password" minlength="8" required autocomplete="${autocomplete}">
    <button class="btn btn-light" type="button" data-toggle-pw aria-label="Show password">${icon('key', 18)}</button></div>
    ${autocomplete === 'new-password' ? '<div class="form-text">At least 8 characters.</div>' : ''}</div>`;

function wirePasswordToggle(root) {
  root.querySelector('[data-toggle-pw]')?.addEventListener('click', () => {
    const input = root.querySelector('#pw');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
}

export function loginView(_, query) {
  const mount = scopedMount();
  const main = mount(authCard({
    heading: '<h1 class="h4 fw-bold mb-1">Welcome back</h1><p class="text-secondary small mb-0">Rent, receipts and repairs, without a caretaker.</p>',
    body: `<form novalidate id="login">
      <div class="mb-3"><label class="form-label small fw-semibold" for="phone">M-Pesa phone number</label>
        <input class="form-control form-control-lg" id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0712 345 678" required></div>
      ${passwordField()}${errorSlot}
      <button class="btn btn-primary btn-lg w-100" type="submit">Sign in</button>
      <p class="text-center small text-secondary mt-3 mb-0">New landlord? <a href="#/register">Create your account</a><br>
        Tenants: use the invite link your landlord sent you.</p>
    </form>`,
  }));
  wirePasswordToggle(main);
  wireForm(main.querySelector('#login'), async (fd) => {
    await login(fd.get('phone'), fd.get('password'));
    navigate(query.next || '/', { replace: true });
  });
}

export function registerView() {
  const mount = scopedMount();
  const main = mount(authCard({
    heading: '<h1 class="h4 fw-bold mb-1">Create your landlord account</h1><p class="text-secondary small mb-0">Free to start. Your tenants pay you directly via M-Pesa.</p>',
    body: `<form novalidate id="register">
      ${field('full_name', 'Your full name', { required: true, attrs: 'autocomplete="name" minlength="2"' })}
      ${field('phone', 'Phone number', { type: 'tel', required: true, placeholder: '0712 345 678', attrs: 'autocomplete="tel" inputmode="tel"' })}
      ${field('email', 'Email (optional)', { type: 'email', attrs: 'autocomplete="email"' })}
      ${passwordField('Choose a password', 'new-password')}${errorSlot}
      <button class="btn btn-primary btn-lg w-100" type="submit">Continue</button>
      <p class="text-center small text-secondary mt-3 mb-0">Already registered? <a href="#/login">Sign in</a></p>
    </form>`,
  }));
  wirePasswordToggle(main);
  wireForm(main.querySelector('#register'), async (fd) => {
    const body = Object.fromEntries(fd);
    if (!body.email) delete body.email;
    const data = await api('/api/v1/auth/register', { method: 'POST', body, auth: false });
    await adoptSession(data);
    navigate('/onboarding', { replace: true });
  });
}

export async function onboardingView() {
  const mount = scopedMount();
  if (!session.isSignedIn) return navigate('/login', { replace: true });
  const list = await counties().catch(() => []);
  const main = mount(authCard({
    heading: '<h1 class="h4 fw-bold mb-1">Set up your business</h1><p class="text-secondary small mb-0">This name appears on invoices, receipts and statements.</p>',
    body: `<form novalidate id="onboard">
      ${field('business_name', 'Business or landlord name', { required: true, placeholder: 'e.g. Akinyi Homes', attrs: 'minlength="2"' })}
      ${select('county_id', 'County', list.map((c) => [c.id, c.name]), { required: true, dataType: 'number' })}
      ${field('kra_pin', 'KRA PIN (optional)', { placeholder: 'P051234567X', attrs: 'pattern="[APap][0-9]{9}[A-Za-z]"', hint: 'Printed on receipts for tax records.' })}
      ${field('default_payment_due_days', 'Days tenants have to pay after an invoice', { type: 'number', value: 5, attrs: 'min="0" max="28"' })}
      ${errorSlot}
      <button class="btn btn-primary btn-lg w-100" type="submit">Create business</button>
    </form>`,
  }, { wide: true }));
  wireForm(main.querySelector('#onboard'), async (fd) => {
    const body = {
      business_name: fd.get('business_name'), county_id: Number(fd.get('county_id')),
      default_payment_due_days: Number(fd.get('default_payment_due_days') || 5),
    };
    if (fd.get('kra_pin')) body.kra_pin = String(fd.get('kra_pin')).toUpperCase();
    const account = await api('/api/v1/accounts', { method: 'POST', body });
    localStorage.setItem('kodi.account', account.id);
    localStorage.setItem('kodi.mode', 'landlord');
    await reloadProfile();
    toast(`Welcome! Add your first property to get started.`, { variant: 'success' });
    navigate('/properties?new=1', { replace: true });
  });
}

export function inviteView(_, query) {
  const mount = scopedMount();
  const token = query.token;
  if (!token) return navigate('/login', { replace: true });
  const main = mount(authCard({
    heading: '<h1 class="h4 fw-bold mb-1">Join your landlord on Kodi</h1><p class="text-secondary small mb-0">Pay rent by M-Pesa, get receipts instantly and report repairs from your phone.</p>',
    body: `<form novalidate id="invite">
      ${passwordField('Create a password', 'new-password')}
      <p class="small text-secondary">If you already use Kodi with this phone number, enter that password instead.</p>
      ${errorSlot}
      <button class="btn btn-primary btn-lg w-100" type="submit">Accept invitation</button>
    </form>`,
  }));
  wirePasswordToggle(main);
  wireForm(main.querySelector('#invite'), async (fd) => {
    const data = await api('/api/v1/auth/accept-invite', { method: 'POST', auth: false, body: { token, password: fd.get('password') } });
    await adoptSession(data);
    localStorage.setItem('kodi.mode', 'tenant');
    toast(`Welcome, ${data.user.full_name.split(' ')[0]}!`, { variant: 'success' });
    navigate('/', { replace: true });
  });
}
