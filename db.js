const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

if (!process.env.DATABASE_URL) {
  console.error('\nDATABASE_URL is missing. Copy .env.example to .env and paste your Neon connection string.\n');
  process.exit(1);
}

const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: false },
  max: 10,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price NUMERIC(10,2) NOT NULL,
  category TEXT DEFAULT 'General',
  image_url TEXT DEFAULT '',
  sizes TEXT DEFAULT 'S,M,L,XL',
  stock INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  items JSONB NOT NULL,
  subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
  shipping NUMERIC(10,2) NOT NULL DEFAULT 0,
  total NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',
  payment_method TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'Unpaid',
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  address JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
`;

const SAMPLES = [
  ['Classic White T-Shirt', 'Soft 100% cotton crew-neck tee. Everyday comfort.', 499, 'Men', 'S,M,L,XL', 50],
  ['Slim Fit Blue Jeans', 'Stretch denim with a modern slim fit.', 1499, 'Men', '28,30,32,34,36', 30],
  ['Floral Summer Dress', 'Light and breezy dress for warm days.', 1299, 'Women', 'S,M,L', 25],
  ['Kurti - Cotton Print', 'Elegant printed cotton kurti, ideal for daily wear.', 799, 'Women', 'S,M,L,XL', 40],
  ['Kids Graphic Hoodie', 'Cozy fleece hoodie with fun print.', 899, 'Kids', '2-3Y,4-5Y,6-7Y', 20],
  ['Leather Belt', 'Genuine leather belt with metal buckle.', 399, 'Accessories', 'Free Size', 60],
];

async function init() {
  await pool.query(SCHEMA);

  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (email && password) {
    const { rows } = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (!rows.length) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        "INSERT INTO users(name,email,password_hash,role) VALUES('Admin',$1,$2,'admin')",
        [email, hash]
      );
      console.log('Admin account created:', email);
    } else {
      await pool.query("UPDATE users SET role='admin' WHERE email=$1", [email]);
    }
  } else {
    console.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set - no admin account was created.');
  }

  const { rows: c } = await pool.query('SELECT COUNT(*)::int AS n FROM products');
  if (c[0].n === 0) {
    for (const [name, description, price, category, sizes, stock] of SAMPLES) {
      await pool.query(
        'INSERT INTO products(name,description,price,category,sizes,stock) VALUES($1,$2,$3,$4,$5,$6)',
        [name, description, price, category, sizes, stock]
      );
    }
    console.log('Added sample products (you can edit or delete them in the admin panel).');
  }
}

module.exports = { pool, init };
