# Super Fashion – Clothing Store

A complete online clothing store: customer shop, cart & checkout, customer login, admin panel (add/edit/delete products, manage orders), and payments (Razorpay online + Cash on Delivery). Works on laptops and mobiles. Data is stored in your **Neon** Postgres database.

## 1. Setup (5 minutes)

You need **Node.js 18 or newer** (https://nodejs.org).

1. Unzip the folder and open a terminal inside `super-fashion`.
2. Install packages:
   ```
   npm install
   ```
3. Copy `.env.example` to a new file named `.env` and fill it in:
   - `DATABASE_URL` – in the Neon dashboard click **Connect** and copy the connection string.
   - `JWT_SECRET` – any long random text.
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD` – your admin login (**change the password!**).
   - `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` – optional, see below.
4. Start the site:
   ```
   npm start
   ```
5. Open http://localhost:3000

On first start the app **creates all tables in Neon automatically**, creates your admin account and adds 6 sample products (edit or delete them from the admin panel).

## 2. Admin panel

Login at `/login` with your `ADMIN_EMAIL` and `ADMIN_PASSWORD`. You will be taken to `/admin`:

- **Dashboard** – revenue, orders, low stock.
- **Products** – add products with image upload (or image link), sizes, stock; edit, hide or delete.
- **Orders** – see customer address and items, change status (Pending → Processing → Shipped → Delivered / Cancelled). Cancelling puts stock back.

Customers register themselves at `/login` → "Create an account".

## 3. Payments

- **Cash on Delivery** works immediately.
- **Online payment (UPI, cards, netbanking)** uses Razorpay. Create an account at https://razorpay.com, copy your Key ID and Key Secret into `.env`, restart. Start with **Test mode** keys. Payments are verified on the server with a signature check before an order is marked Paid.

Free shipping above ₹999, otherwise ₹79 – change `FREE_SHIPPING_ABOVE` and `SHIPPING_FEE` at the top of `server.js`.

## 4. Putting it online

Deploy to any Node host (Render, Railway, VPS...). Set the same values from `.env` as environment variables, plus `NODE_ENV=production`, and the start command `npm start`. Use HTTPS (required for payments).

**Important about images:** uploaded product images are saved in `public/uploads`. Many free hosts erase files on restart. For those hosts use the **image link (URL)** option in the admin panel (e.g. images hosted on Cloudinary/ImgBB), or use a host with a persistent disk.

## 5. Folder structure

```
server.js        – backend API (login, products, orders, payments, admin)
db.js            – Neon connection + automatic table creation
public/          – website pages (index, product, checkout, orders, login, admin)
public/css       – styles (responsive)
public/js/app.js – shared front-end code
```
