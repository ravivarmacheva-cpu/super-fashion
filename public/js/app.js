// Shared helpers for all Super Fashion pages
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

async function api(url, opts = {}) {
  const o = { credentials: 'same-origin', ...opts };
  if (o.body && !(o.body instanceof FormData)) {
    o.headers = { 'Content-Type': 'application/json', ...(o.headers || {}) };
    o.body = JSON.stringify(o.body);
  }
  const r = await fetch(url, o);
  let d = {};
  try { d = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
}

function toast(msg, isErr) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ''), 2800);
}

// ----- cart (saved in the browser) -----
const Cart = {
  get() { try { return JSON.parse(localStorage.getItem('sf_cart')) || []; } catch (_) { return []; } },
  save(c) { localStorage.setItem('sf_cart', JSON.stringify(c)); updateCartBadge(); },
  add(p, size, qty = 1) {
    const c = this.get();
    const ex = c.find((i) => i.id === p.id && i.size === size);
    if (ex) ex.qty = Math.min(20, ex.qty + qty);
    else c.push({ id: p.id, name: p.name, price: Number(p.price), image_url: p.image_url, size, qty });
    this.save(c);
  },
  setQty(id, size, qty) {
    let c = this.get();
    c = qty <= 0 ? c.filter((i) => !(i.id === id && i.size === size)) : c.map((i) => (i.id === id && i.size === size ? { ...i, qty: Math.min(20, qty) } : i));
    this.save(c);
  },
  clear() { this.save([]); },
  count() { return this.get().reduce((n, i) => n + i.qty, 0); },
  subtotal() { return this.get().reduce((n, i) => n + i.price * i.qty, 0); },
};
function updateCartBadge() {
  const b = $('#cart-count');
  if (b) b.textContent = Cart.count();
}

function productImage(p) {
  return p.image_url
    ? `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" onerror="this.outerHTML='<div class=&quot;ph&quot;>${esc((p.name || '?')[0])}</div>'">`
    : `<div class="ph">${esc((p.name || '?')[0])}</div>`;
}

// ----- header / footer -----
async function initHeader() {
  let user = null;
  try { user = (await api('/api/auth/me')).user; } catch (_) {}
  window.currentUser = user;
  const h = document.getElementById('site-header');
  if (h) {
    h.className = 'site-header';
    h.innerHTML = `
      <div class="container bar">
        <a class="logo" href="/">SUPER<span>FASHION</span></a>
        <nav class="nav">
          <a href="/">Shop</a>
          ${user ? '<a href="/orders">My Orders</a>' : ''}
          ${user && user.role === 'admin' ? '<a href="/admin">Admin</a>' : ''}
          ${user ? `<button id="logout-btn">Logout (${esc(user.name.split(' ')[0])})</button>` : '<a href="/login">Login</a>'}
          <a class="cart-link" href="/checkout">🛒 Cart<span class="badge" id="cart-count">0</span></a>
        </nav>
      </div>`;
    const lo = $('#logout-btn');
    if (lo) lo.onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; };
  }
  const f = document.getElementById('site-footer');
  if (f) f.innerHTML = '<footer>© ' + new Date().getFullYear() + ' Super Fashion. All rights reserved.</footer>';
  updateCartBadge();
  return user;
}

function nextParam() {
  const n = new URLSearchParams(location.search).get('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : null;
}
