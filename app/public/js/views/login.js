import { post } from '../api.js';
import { h } from '../util.js';
import { refreshSession, session, navigate } from '../app.js';
import { cipherMark } from '../theme.js';

export async function mount(root, { mode }) {
  const isSetup = mode === 'setup' || session.needsSetup;
  const error = h('div.error-text');
  const username = h('input.focusable', { type: 'text', autocomplete: 'username', autocapitalize: 'off', required: true, 'data-autofocus': true });
  const password = h('input.focusable', { type: 'password', autocomplete: isSetup ? 'new-password' : 'current-password', required: true });
  const confirm = isSetup ? h('input.focusable', { type: 'password', autocomplete: 'new-password', required: true }) : null;
  const submit = h('button.btn.primary.focusable', { type: 'submit' }, isSetup ? 'Create account' : 'Sign in');

  const form = h('form.form', {
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (isSetup && password.value !== confirm.value) {
        error.textContent = 'Passwords do not match';
        return;
      }
      submit.disabled = true;
      try {
        await post(isSetup ? '/auth/setup' : '/auth/login', { username: username.value, password: password.value });
        await refreshSession();
        navigate('home', { replace: true });
        if (location.hash === '#/home') window.dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (err) {
        error.textContent = err.message;
      } finally {
        submit.disabled = false;
      }
    },
  },
  h('div.field', {}, h('label', { text: 'Username' }), username),
  h('div.field', {}, h('label', { text: 'Password' }), password),
  confirm ? h('div.field', {}, h('label', { text: 'Confirm password' }), confirm) : null,
  error,
  submit);

  root.append(h('div.auth-wrap', {}, h('div.card.auth-card', {},
    h('div.brand', { style: 'margin-bottom:1rem' }, cipherMark()),
    h('h2', { text: isSetup ? 'Create the admin account' : 'Sign in' }),
    isSetup ? h('p.hint', { text: 'This is the first visit. The account you create here can add other users in Settings.' }) : null,
    form,
  )));
  return {};
}
