// Small enhancements only: every page works without this file.
document.documentElement.classList.add('js');

// The live region exists before anything is said in it, so screen readers announce it.
const box = document.createElement('div');
box.className = 'toast';
box.setAttribute('role', 'status');
document.body.append(box);

function toast(text) {
  box.textContent = text;
  box.classList.add('is-shown');
  clearTimeout(box.hideTimer);
  box.hideTimer = setTimeout(() => box.classList.remove('is-shown'), 2200);
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(done);
}

// "Copier" buttons: data-copy holds the text.
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  copy(button.dataset.copy, button.dataset.copied || 'Copié');
});

// Show / hide the password.
for (const button of document.querySelectorAll('[data-reveal]')) {
  const input = document.getElementById(button.dataset.reveal);
  button.hidden = false;
  button.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? 'Masquer' : 'Afficher';
    button.setAttribute('aria-pressed', String(show));
    input.focus();
  });
}

// École Directe can take a few seconds: say so, and stop double submits.
for (const form of document.querySelectorAll('form[data-busy]')) {
  form.addEventListener('submit', (event) => {
    if (form.dataset.sent) {
      event.preventDefault();
      return;
    }
    form.dataset.sent = '1';
    const button = form.querySelector('button[type="submit"]');
    if (button) {
      button.setAttribute('aria-busy', 'true');
      button.textContent = form.dataset.busy;
    }
  });
}

// Destructive admin actions ask first.
for (const form of document.querySelectorAll('form[data-confirm]')) {
  form.addEventListener('submit', (event) => {
    if (!confirm(form.dataset.confirm)) event.preventDefault();
  });
}

// Admin filters apply as soon as they change.
for (const select of document.querySelectorAll('[data-autosubmit]')) {
  select.addEventListener('change', () => select.form.submit());
}

// The landing conversation plays once.
const lines = [...document.querySelectorAll('.chat [data-say]')];
if (lines.length) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  lines.forEach((line, index) => {
    if (reduce) line.classList.add('is-said');
    else setTimeout(() => line.classList.add('is-said'), 350 + index * 700);
  });
}
