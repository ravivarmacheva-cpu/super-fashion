require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { pool, init } = require('./db');

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is missing in .env');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const isProd = process.env.NODE_ENV === 'production';
const RZP_KEY = process.env.RAZORPAY_KEY_ID || '';
const RZP_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const razorpayEnabled = !!(RZP_KEY && RZP_SECRET);
const FREE_SHIPPING_ABOVE = 999;
const SHIPPING_FEE = 79;

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpErr = (status, message) => Object.assign(new Error(message), { status });

function setLoginCookie(res, user) {
  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: 7 * 24 * 3600 * 1000,
  });
}

async function loadUser(req, _res, next) {
  req.user = null;
  const token = req.cookies.token;
  if (token) {
    try {
      const p = jwt.verify(token, process.env.JWT_SECRET);
      const { rows } = await pool.query('SELECT id,name,email,role FROM users WHERE id=$1', [p.id]);
      req.user = rows[0] || null;
    } catch (_) { /* invalid token -> treat as logged out */ }
  }
  next();
}
const requireLogin = (req, _res, next) => (req.user ? next() : next(httpErr(401, 'Please login first')));
const requireAdmin = (req, _res, next) =>
  req.user && req.user.role === 'admin' ? next() : next(httpErr(403, 'Admin access only'));

app.use(loadUser);

// ---------- image upload ----------
const uploadDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) ? cb(null, true) : cb(httpErr(400, 'Only JPG, PNG, WEBP or GIF images allowed')),
});

// ---------- auth ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });

app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (name.length < 2) throw httpErr(400, 'Please enter your name');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw httpErr(400, 'Please enter a valid email');
  if (password.length < 6) throw httpErr(400, 'Password must be at least 6 characters');
  const exists = await pool.query('SELECT 1 FROM users WHERE email=$1', [email]);
  if (exists.rowCount) throw httpErr(409, 'This email is already registered');
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    "INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'customer') RETURNING id,name,email,role",
    [name, email, hash]
  );
  setLoginCookie(res, rows[0]);
  res.json({ user: rows[0] });
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) throw httpErr(401, 'Wrong email or password');
  setLoginCookie(res, u);
  res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role } });
}));

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));

// ---------- public catalog ----------
app.get('/api/config', (_req, res) =>
  res.json({ razorpayEnabled, razorpayKey: razorpayEnabled ? RZP_KEY : null, freeShippingAbove: FREE_SHIPPING_ABOVE, shippingFee: SHIPPING_FEE })
);

app.get('/api/products', wrap(async (req, res) => {
  const params = [];
  let sql = 'SELECT * FROM products WHERE active=true';
  if (req.query.category && req.query.category !== 'All') {
    params.push(req.query.category);
    sql += ` AND category=$${params.length}`;
  }
  if (req.query.q) {
    params.push('%' + String(req.query.q).trim() + '%');
    sql += ` AND (name ILIKE $${params.length} OR description ILIKE $${params.length})`;
  }
  sql += ' ORDER BY created_at DESC, id DESC';
  const { rows } = await pool.query(sql, params);
  res.json({ products: rows });
}));

app.get('/api/categories', wrap(async (_req, res) => {
  const { rows } = await pool.query("SELECT DISTINCT category FROM products WHERE active=true ORDER BY category");
  res.json({ categories: rows.map((r) => r.category) });
}));

app.get('/api/products/:id', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE id=$1 AND active=true', [parseInt(req.params.id) || 0]);
  if (!rows.length) throw httpErr(404, 'Product not found');
  res.json({ product: rows[0] });
}));

// ---------- orders ----------
function validAddress(a) {
  a = a || {};
  const out = {
    name: String(a.name || '').trim(),
    phone: String(a.phone || '').trim(),
    line: String(a.line || '').trim(),
    city: String(a.city || '').trim(),
    state: String(a.state || '').trim(),
    pincode: String(a.pincode || '').trim(),
  };
  if (out.name.length < 2) throw httpErr(400, 'Enter your full name');
  if (!/^[0-9+\-\s]{8,15}$/.test(out.phone)) throw httpErr(400, 'Enter a valid phone number');
  if (out.line.length < 5) throw httpErr(400, 'Enter your full address');
  if (!out.city || !out.state) throw httpErr(400, 'Enter city and state');
  if (!/^[0-9]{5,8}$/.test(out.pincode)) throw httpErr(400, 'Enter a valid pincode');
  return out;
}

// Prices always come from the database, never from the browser.
async function priceItems(items, client) {
  if (!Array.isArray(items) || !items.length) throw httpErr(400, 'Your cart is empty');
  const ids = [...new Set(items.map((i) => parseInt(i.id)).filter(Boolean))];
  const { rows } = await client.query('SELECT * FROM products WHERE id = ANY($1) AND active=true', [ids]);
  const map = new Map(rows.map((p) => [p.id, p]));
  const lines = [];
  const perProduct = new Map();
  let subtotal = 0;
  for (const it of items) {
    const p = map.get(parseInt(it.id));
    const qty = parseInt(it.qty);
    if (!p || !(qty > 0) || qty > 20) throw httpErr(400, 'One of the items in your cart is not available');
    perProduct.set(p.id, (perProduct.get(p.id) || 0) + qty);
    if (perProduct.get(p.id) > p.stock) throw httpErr(400, `Only ${p.stock} left for "${p.name}"`);
    const price = Number(p.price);
    subtotal += price * qty;
    lines.push({ id: p.id, name: p.name, price, qty, size: String(it.size || '').slice(0, 20), image_url: p.image_url });
  }
  const shipping = subtotal >= FREE_SHIPPING_ABOVE ? 0 : SHIPPING_FEE;
  return { lines, subtotal, shipping, total: subtotal + shipping, perProduct };
}

async function reduceStock(client, perProduct) {
  for (const [id, qty] of perProduct) {
    const r = await client.query('UPDATE products SET stock = stock - $1 WHERE id=$2 AND stock >= $1', [qty, id]);
    if (!r.rowCount) throw httpErr(400, 'Sorry, an item just went out of stock');
  }
}

// Cash on Delivery order
app.post('/api/orders', requireLogin, wrap(async (req, res) => {
  const address = validAddress(req.body.address);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const priced = await priceItems(req.body.items, client);
    await reduceStock(client, priced.perProduct);
    const { rows } = await client.query(
      `INSERT INTO orders(user_id,items,subtotal,shipping,total,status,payment_method,payment_status,address)
       VALUES($1,$2,$3,$4,$5,'Pending','COD','Unpaid',$6) RETURNING id,total`,
      [req.user.id, JSON.stringify(priced.lines), priced.subtotal, priced.shipping, priced.total, address]
    );
    await client.query('COMMIT');
    res.json({ order: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

app.get('/api/orders/mine', requireLogin, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC', [req.user.id]);
  res.json({ orders: rows });
}));

// ---------- Razorpay payments ----------
app.post('/api/payments/create', requireLogin, wrap(async (req, res) => {
  if (!razorpayEnabled) throw httpErr(400, 'Online payment is not enabled yet');
  const address = validAddress(req.body.address);
  const priced = await priceItems(req.body.items, pool);
  const ins = await pool.query(
    `INSERT INTO orders(user_id,items,subtotal,shipping,total,status,payment_method,payment_status,address)
     VALUES($1,$2,$3,$4,$5,'Awaiting Payment','Online','Unpaid',$6) RETURNING id`,
    [req.user.id, JSON.stringify(priced.lines), priced.subtotal, priced.shipping, priced.total, address]
  );
  const orderId = ins.rows[0].id;
  const r = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(RZP_KEY + ':' + RZP_SECRET).toString('base64'),
    },
    body: JSON.stringify({ amount: Math.round(priced.total * 100), currency: 'INR', receipt: 'sf_' + orderId }),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error('Razorpay error:', data);
    throw httpErr(502, 'Could not start payment. Please try again.');
  }
  await pool.query('UPDATE orders SET razorpay_order_id=$1 WHERE id=$2', [data.id, orderId]);
  res.json({
    orderId,
    razorpayOrderId: data.id,
    amount: data.amount,
    currency: data.currency,
    key: RZP_KEY,
    customer: { name: address.name, email: req.user.email, phone: address.phone },
  });
}));

app.post('/api/payments/verify', requireLogin, wrap(async (req, res) => {
  const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const { rows } = await pool.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [parseInt(orderId) || 0, req.user.id]);
  const order = rows[0];
  if (!order || order.razorpay_order_id !== razorpay_order_id) throw httpErr(400, 'Order not found');
  if (order.payment_status === 'Paid') return res.json({ order: { id: order.id } });

  const expected = crypto.createHmac('sha256', RZP_SECRET).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(razorpay_signature || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpErr(400, 'Payment verification failed');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let status = 'Pending';
    try {
      const perProduct = new Map();
      for (const l of order.items) perProduct.set(l.id, (perProduct.get(l.id) || 0) + l.qty);
      await client.query('SAVEPOINT stock');
      await reduceStock(client, perProduct);
    } catch (_) {
      await client.query('ROLLBACK TO SAVEPOINT stock');
      status = 'Needs Review'; // paid, but stock ran out - admin should contact customer
    }
    await client.query(
      "UPDATE orders SET payment_status='Paid', status=$1, razorpay_payment_id=$2 WHERE id=$3",
      [status, razorpay_payment_id, order.id]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ order: { id: order.id } });
}));

// ---------- admin ----------
function readProduct(req, existing) {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const price = parseFloat(b.price);
  const stock = parseInt(b.stock);
  if (!name) throw httpErr(400, 'Product name is required');
  if (!(price >= 0)) throw httpErr(400, 'Enter a valid price');
  if (!(stock >= 0)) throw httpErr(400, 'Enter a valid stock number');
  let image = existing ? existing.image_url : '';
  if (req.file) image = '/uploads/' + req.file.filename;
  else if (String(b.image_url || '').trim()) image = String(b.image_url).trim();
  return {
    name,
    description: String(b.description || '').trim(),
    price,
    category: String(b.category || 'General').trim() || 'General',
    image_url: image,
    sizes: String(b.sizes || 'S,M,L,XL').split(',').map((s) => s.trim()).filter(Boolean).join(','),
    stock,
    active: b.active === undefined ? true : b.active === 'true' || b.active === true || b.active === 'on',
  };
}

app.get('/api/admin/stats', requireAdmin, wrap(async (_req, res) => {
  const q = async (sql) => (await pool.query(sql)).rows[0];
  const orders = await q("SELECT COUNT(*)::int AS n, COALESCE(SUM(total) FILTER (WHERE status NOT IN ('Cancelled','Awaiting Payment')),0)::float AS revenue FROM orders");
  const pending = await q("SELECT COUNT(*)::int AS n FROM orders WHERE status IN ('Pending','Needs Review')");
  const products = await q('SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE stock <= 5)::int AS low FROM products');
  const customers = await q("SELECT COUNT(*)::int AS n FROM users WHERE role='customer'");
  res.json({ orders: orders.n, revenue: orders.revenue, pending: pending.n, products: products.n, lowStock: products.low, customers: customers.n });
}));

app.get('/api/admin/products', requireAdmin, wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM products ORDER BY id DESC');
  res.json({ products: rows });
}));

app.post('/api/admin/products', requireAdmin, upload.single('image'), wrap(async (req, res) => {
  const p = readProduct(req, null);
  const { rows } = await pool.query(
    'INSERT INTO products(name,description,price,category,image_url,sizes,stock,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [p.name, p.description, p.price, p.category, p.image_url, p.sizes, p.stock, p.active]
  );
  res.json({ product: rows[0] });
}));

app.put('/api/admin/products/:id', requireAdmin, upload.single('image'), wrap(async (req, res) => {
  const id = parseInt(req.params.id) || 0;
  const cur = (await pool.query('SELECT * FROM products WHERE id=$1', [id])).rows[0];
  if (!cur) throw httpErr(404, 'Product not found');
  const p = readProduct(req, cur);
  const { rows } = await pool.query(
    'UPDATE products SET name=$1,description=$2,price=$3,category=$4,image_url=$5,sizes=$6,stock=$7,active=$8 WHERE id=$9 RETURNING *',
    [p.name, p.description, p.price, p.category, p.image_url, p.sizes, p.stock, p.active, id]
  );
  res.json({ product: rows[0] });
}));

app.delete('/api/admin/products/:id', requireAdmin, wrap(async (req, res) => {
  await pool.query('DELETE FROM products WHERE id=$1', [parseInt(req.params.id) || 0]);
  res.json({ ok: true });
}));

app.get('/api/admin/orders', requireAdmin, wrap(async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT o.*, u.name AS customer_name, u.email AS customer_email FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 300'
  );
  res.json({ orders: rows });
}));

const STATUSES = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled', 'Needs Review'];
app.put('/api/admin/orders/:id/status', requireAdmin, wrap(async (req, res) => {
  const status = String(req.body.status || '');
  if (!STATUSES.includes(status)) throw httpErr(400, 'Invalid status');
  const id = parseInt(req.params.id) || 0;
  const cur = (await pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
  if (!cur) throw httpErr(404, 'Order not found');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // put stock back if an order that reserved stock is cancelled
    if (status === 'Cancelled' && cur.status !== 'Cancelled' && cur.status !== 'Awaiting Payment') {
      for (const l of cur.items) await client.query('UPDATE products SET stock = stock + $1 WHERE id=$2', [l.qty, l.id]);
    }
    const paySql = status === 'Delivered' && cur.payment_method === 'COD' ? ", payment_status='Paid'" : '';
    await client.query(`UPDATE orders SET status=$1${paySql} WHERE id=$2`, [status, id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

// ---------- static site + errors ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) err = httpErr(400, err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 3 MB' : err.message);
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Server error. Please try again.' : err.message });
});

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, () => console.log(`Super Fashion running on http://localhost:${PORT}`)))
  .catch((e) => {
    console.error('Could not start. Check DATABASE_URL in .env\n', e.message);
    process.exit(1);
  });
