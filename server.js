require("dotenv").config();

const express = require("express");
const Database = require("better-sqlite3");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "troque-essa-senha";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(",") : true
}));

app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 160,
  standardHeaders: true,
  legacyHeaders: false
});

const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." }
});

const adminLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(generalLimiter);

const db = new Database("database.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  cpf TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  numbers TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  pix_code TEXT,
  qr_code_base64 TEXT,
  ticket_url TEXT,
  mp_payment_id TEXT UNIQUE,
  mp_status TEXT,
  reserved_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT,
  customer_password_hash TEXT,
  customer_salt TEXT
);

CREATE TABLE IF NOT EXISTS raffle_numbers (
  number INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'available',
  order_id INTEGER,
  reserved_until TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  order_id INTEGER,
  ip TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);


function addColumnIfMissing(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

addColumnIfMissing("orders", "customer_password_hash", "TEXT");
addColumnIfMissing("orders", "customer_salt", "TEXT");

function setDefaultConfig(key, value) {
  const exists = db.prepare("SELECT value FROM config WHERE key = ?").get(key);
  if (!exists) db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(key, value);
}

setDefaultConfig("title", "BMW F800 GS Adventure 2015 + 4 PIX Premiados");
setDefaultConfig("brand", "Rifa da Sorte Scobar 00 da Serra");
setDefaultConfig("unit_price_cents", "50");
setDefaultConfig("min_numbers", "20");
setDefaultConfig("total_numbers", "300000");
setDefaultConfig("reservation_minutes", "30");
setDefaultConfig("goal_bmw_cents", "15000000");
setDefaultConfig("goal_pix_500_1_cents", "150000");
setDefaultConfig("goal_pix_500_2_cents", "400000");
setDefaultConfig("goal_pix_500_3_cents", "800000");
setDefaultConfig("goal_pix_1000_cents", "4000000");

function getConfig() {
  const rows = db.prepare("SELECT key, value FROM config").all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function ensureNumbers() {
  const config = getConfig();
  const total = Number(config.total_numbers || 300000);
  const count = db.prepare("SELECT COUNT(*) as count FROM raffle_numbers").get().count;

  if (count < total) {
    const insert = db.prepare("INSERT OR IGNORE INTO raffle_numbers (number) VALUES (?)");
    const trx = db.transaction(() => {
      for (let i = count + 1; i <= total; i++) insert.run(i);
    });
    trx();
  }
}
ensureNumbers();

function logEvent(event, orderId, req, details = {}) {
  db.prepare(`
    INSERT INTO audit_logs (event, order_id, ip, details)
    VALUES (?, ?, ?, ?)
  `).run(event, orderId || null, req?.ip || "", JSON.stringify(details).slice(0, 2000));
}

function clearExpiredReservations() {
  const expired = db.prepare(`
    SELECT id, numbers FROM orders
    WHERE status = 'reserved'
    AND reserved_until IS NOT NULL
    AND datetime(reserved_until) < datetime('now')
  `).all();

  const trx = db.transaction(() => {
    for (const order of expired) {
      db.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'reserved'").run(order.id);
      const numbers = JSON.parse(order.numbers || "[]");
      const release = db.prepare(`
        UPDATE raffle_numbers
        SET status = 'available', order_id = NULL, reserved_until = NULL
        WHERE number = ? AND order_id = ? AND status = 'reserved'
      `);
      for (const n of numbers) release.run(n, order.id);
    }
  });

  trx();
}

function formatNumber(n) {
  return String(n).padStart(6, "0");
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function hashPassword(password, salt) {
  return crypto
    .createHash("sha256")
    .update(String(password) + String(salt))
    .digest("hex");
}

function checkPassword(password, salt, storedHash) {
  if (!password || !salt || !storedHash) return false;
  return hashPassword(password, salt) === storedHash;
}

function isValidCpf(cpf) {
  cpf = onlyDigits(cpf);
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(cpf[i]) * (10 - i);
  let d1 = 11 - (sum % 11);
  if (d1 >= 10) d1 = 0;
  if (d1 !== Number(cpf[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cpf[i]) * (11 - i);
  let d2 = 11 - (sum % 11);
  if (d2 >= 10) d2 = 0;

  return d2 === Number(cpf[10]);
}

function splitName(fullName) {
  const parts = String(fullName).trim().split(/\s+/);
  return {
    firstName: parts[0] || "Cliente",
    lastName: parts.slice(1).join(" ") || "Rifa"
  };
}

function safeOrderPublic(order) {
  return {
    id: order.id,
    customerName: order.customer_name,
    phone: order.phone,
    quantity: order.quantity,
    amountCents: order.amount_cents,
    status: order.status,
    numbers: JSON.parse(order.numbers).map(formatNumber),
    pixCode: order.pix_code,
    qrCodeBase64: order.qr_code_base64,
    ticketUrl: order.ticket_url,
    reservedUntil: order.reserved_until,
    createdAt: order.created_at,
    paidAt: order.paid_at
  };
}

async function createMercadoPagoPix({ orderId, uuid, amountCents, customerName, cpf, email }) {
  if (!MP_ACCESS_TOKEN) {
    throw new Error("MP_ACCESS_TOKEN ausente. Configure o token do Mercado Pago no arquivo .env.");
  }

  const { firstName, lastName } = splitName(customerName);
  const expiration = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const payload = {
    transaction_amount: Number((amountCents / 100).toFixed(2)),
    description: `Rifa da Sorte Scobar BMW + PIX - Pedido #${orderId}`,
    payment_method_id: "pix",
    external_reference: String(orderId),
    date_of_expiration: expiration,
    payer: {
      email,
      first_name: firstName,
      last_name: lastName,
      identification: {
        type: "CPF",
        number: cpf
      }
    }
  };

  if (PUBLIC_BASE_URL) {
    payload.notification_url = `${PUBLIC_BASE_URL.replace(/\/$/, "")}/api/webhooks/mercadopago`;
  }

  const response = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": uuid
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.message || JSON.stringify(data));
  }

  const tx = data?.point_of_interaction?.transaction_data || {};

  return {
    mpPaymentId: String(data.id),
    mpStatus: data.status,
    pixCode: tx.qr_code || "",
    qrCodeBase64: tx.qr_code_base64 || "",
    ticketUrl: tx.ticket_url || ""
  };
}

async function getMercadoPagoPayment(paymentId) {
  if (!MP_ACCESS_TOKEN) throw new Error("MP_ACCESS_TOKEN ausente.");

  const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { "Authorization": `Bearer ${MP_ACCESS_TOKEN}` }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.message || JSON.stringify(data));
  }

  return data;
}

function applyPaymentStatus(payment, req) {
  const orderId = Number(payment.external_reference);
  if (!orderId) return { ok: true, ignored: "sem external_reference" };

  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) return { ok: true, ignored: "pedido não encontrado" };

  if (String(order.mp_payment_id || "") && String(order.mp_payment_id) !== String(payment.id)) {
    logEvent("webhook_payment_mismatch", orderId, req, { received: payment.id, expected: order.mp_payment_id });
    return { ok: true, ignored: "payment mismatch" };
  }

  const status = payment.status;

  const tx = db.transaction(() => {
    db.prepare("UPDATE orders SET mp_status = ?, mp_payment_id = ? WHERE id = ?")
      .run(status, String(payment.id), orderId);

    if (status === "approved" && order.status !== "paid") {
      db.prepare("UPDATE orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(orderId);

      const numbers = JSON.parse(order.numbers || "[]");
      const update = db.prepare(`
        UPDATE raffle_numbers
        SET status = 'paid', reserved_until = NULL
        WHERE number = ? AND order_id = ?
      `);

      for (const n of numbers) update.run(n, orderId);
    }

    if (["cancelled", "rejected", "refunded", "charged_back"].includes(status) && order.status === "reserved") {
      db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, orderId);
      db.prepare(`
        UPDATE raffle_numbers
        SET status = 'available', order_id = NULL, reserved_until = NULL
        WHERE order_id = ? AND status = 'reserved'
      `).run(orderId);
    }
  });

  tx();
  logEvent("payment_status_applied", orderId, req, { paymentId: payment.id, status });
  return { ok: true, orderId, status };
}

app.get("/api/campaign", (req, res) => {
  clearExpiredReservations();
  const config = getConfig();

  const paid = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) as total FROM orders WHERE status = 'paid'").get().total;
  const soldNumbers = db.prepare("SELECT COUNT(*) as count FROM raffle_numbers WHERE status = 'paid'").get().count;
  const reservedNumbers = db.prepare("SELECT COUNT(*) as count FROM raffle_numbers WHERE status = 'reserved'").get().count;

  res.json({
    title: config.title,
    brand: config.brand,
    unitPriceCents: Number(config.unit_price_cents),
    minNumbers: Number(config.min_numbers),
    totalNumbers: Number(config.total_numbers),
    paidCents: paid,
    soldNumbers,
    reservedNumbers,
    goals: {
      pix500_1: Number(config.goal_pix_500_1_cents),
      pix500_2: Number(config.goal_pix_500_2_cents),
      pix500_3: Number(config.goal_pix_500_3_cents),
      pix1000: Number(config.goal_pix_1000_cents),
      bmw: Number(config.goal_bmw_cents)
    }
  });
});

app.post("/api/orders", orderLimiter, async (req, res) => {
  clearExpiredReservations();

  const config = getConfig();
  const minNumbers = Number(config.min_numbers || 20);
  const unitPrice = Number(config.unit_price_cents || 50);
  const reservationMinutes = Number(config.reservation_minutes || 30);

  const customerName = String(req.body.customerName || "").trim();
  const phone = onlyDigits(req.body.phone);
  const email = String(req.body.email || "").trim().toLowerCase();
  const cpf = onlyDigits(req.body.cpf);
  const qty = Number(req.body.quantity);
  const customerPassword = String(req.body.customerPassword || "").trim();

  if (customerName.length < 5) return res.status(400).json({ error: "Informe o nome completo." });
  if (phone.length < 10 || phone.length > 13) return res.status(400).json({ error: "Informe um WhatsApp válido." });
  if (!email.includes("@") || email.length < 6) return res.status(400).json({ error: "Informe um e-mail válido." });
  if (!isValidCpf(cpf)) return res.status(400).json({ error: "Informe um CPF válido." });
  if (customerPassword.length < 6) return res.status(400).json({ error: "Crie uma senha com no mínimo 6 caracteres para acompanhar seus pedidos." });
  if (!Number.isInteger(qty) || qty < minNumbers) return res.status(400).json({ error: `Selecione no mínimo ${minNumbers} números.` });
  if (qty > 5000) return res.status(400).json({ error: "Quantidade máxima por pedido: 5000 números." });

  const amountCents = qty * unitPrice;
  const uuid = crypto.randomUUID();
  const reservedUntil = new Date(Date.now() + reservationMinutes * 60 * 1000).toISOString();
  const customerSalt = crypto.randomBytes(16).toString("hex");
  const customerPasswordHash = hashPassword(customerPassword, customerSalt);

  const createOrderTx = db.transaction(() => {
    const available = db.prepare(`
      SELECT number FROM raffle_numbers
      WHERE status = 'available'
      ORDER BY RANDOM()
      LIMIT ?
    `).all(qty);

    if (available.length < qty) {
      throw new Error("Não há números suficientes disponíveis.");
    }

    const numbers = available.map(r => r.number);

    const result = db.prepare(`
      INSERT INTO orders (
        uuid, customer_name, phone, email, cpf, quantity, amount_cents,
        status, numbers, ip, user_agent, reserved_until, customer_password_hash, customer_salt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?)
    `).run(
      uuid,
      customerName,
      phone,
      email,
      cpf,
      qty,
      amountCents,
      JSON.stringify(numbers),
      req.ip,
      req.headers["user-agent"] || "",
      reservedUntil,
      customerPasswordHash,
      customerSalt
    );

    const orderId = result.lastInsertRowid;

    const update = db.prepare(`
      UPDATE raffle_numbers
      SET status = 'reserved', order_id = ?, reserved_until = ?
      WHERE number = ? AND status = 'available'
    `);

    for (const number of numbers) update.run(orderId, reservedUntil, number);

    return { orderId, numbers };
  });

  try {
    const created = createOrderTx();
    logEvent("order_reserved", created.orderId, req, { qty, amountCents });

    let pix;
    try {
      pix = await createMercadoPagoPix({
        orderId: created.orderId,
        uuid,
        amountCents,
        customerName,
        cpf,
        email
      });
    } catch (mpError) {
      db.prepare("UPDATE orders SET status = 'payment_error' WHERE id = ?").run(created.orderId);
      db.prepare(`
        UPDATE raffle_numbers
        SET status = 'available', order_id = NULL, reserved_until = NULL
        WHERE order_id = ? AND status = 'reserved'
      `).run(created.orderId);

      logEvent("mp_payment_error", created.orderId, req, { error: mpError.message });
      return res.status(500).json({
        error: "Erro ao gerar Pix. Confira o token Mercado Pago no .env.",
        details: mpError.message
      });
    }

    db.prepare(`
      UPDATE orders
      SET pix_code = ?, qr_code_base64 = ?, ticket_url = ?, mp_payment_id = ?, mp_status = ?
      WHERE id = ?
    `).run(
      pix.pixCode,
      pix.qrCodeBase64,
      pix.ticketUrl,
      pix.mpPaymentId,
      pix.mpStatus,
      created.orderId
    );

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(created.orderId);
    res.json({
      ...safeOrderPublic(order),
      message: "Pix gerado. Os números ficam reservados até o vencimento. Após pagamento aprovado, a confirmação é automática."
    });
  } catch (err) {
    logEvent("order_error", null, req, { error: err.message });
    res.status(409).json({ error: err.message });
  }
});

app.get("/api/order/:id", (req, res) => {
  clearExpiredReservations();
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  res.json(safeOrderPublic(order));
});

app.post("/api/webhooks/mercadopago", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id || req.query?.id || req.body?.id;
    if (!paymentId) return res.status(200).json({ ok: true, ignored: "sem paymentId" });

    const payment = await getMercadoPagoPayment(paymentId);
    const result = applyPaymentStatus(payment, req);

    return res.status(200).json(result);
  } catch (err) {
    logEvent("mp_webhook_error", null, req, { error: err.message });
    return res.status(200).json({ ok: false });
  }
});


app.post("/api/customer/login", orderLimiter, (req, res) => {
  clearExpiredReservations();

  const phone = onlyDigits(req.body.phone);
  const password = String(req.body.password || "");

  if (phone.length < 10 || password.length < 6) {
    return res.status(400).json({ error: "Informe WhatsApp e senha válidos." });
  }

  const order = db.prepare(`
    SELECT id, customer_name, phone, customer_password_hash, customer_salt
    FROM orders
    WHERE phone = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(phone);

  if (!order || !checkPassword(password, order.customer_salt, order.customer_password_hash)) {
    return res.status(401).json({ error: "WhatsApp ou senha inválidos." });
  }

  const tokenPayload = `${phone}:${Date.now()}:${crypto.randomBytes(12).toString("hex")}`;
  const token = Buffer.from(tokenPayload).toString("base64url");

  res.json({
    ok: true,
    token,
    customerName: order.customer_name,
    message: "Login realizado com sucesso."
  });
});

app.post("/api/customer/orders", orderLimiter, (req, res) => {
  clearExpiredReservations();

  const phone = onlyDigits(req.body.phone);
  const password = String(req.body.password || "");

  if (phone.length < 10 || password.length < 6) {
    return res.status(400).json({ error: "Informe WhatsApp e senha válidos." });
  }

  const authOrder = db.prepare(`
    SELECT customer_password_hash, customer_salt
    FROM orders
    WHERE phone = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(phone);

  if (!authOrder || !checkPassword(password, authOrder.customer_salt, authOrder.customer_password_hash)) {
    return res.status(401).json({ error: "WhatsApp ou senha inválidos." });
  }

  const rows = db.prepare(`
    SELECT * FROM orders
    WHERE phone = ?
    ORDER BY id DESC
    LIMIT 50
  `).all(phone);

  const orders = rows.map(o => ({
    id: o.id,
    customerName: o.customer_name,
    quantity: o.quantity,
    amountCents: o.amount_cents,
    status: o.status,
    mpStatus: o.mp_status,
    numbers: JSON.parse(o.numbers || "[]").map(formatNumber),
    createdAt: o.created_at,
    paidAt: o.paid_at,
    ticketUrl: o.ticket_url
  }));

  res.json({
    ok: true,
    orders
  });
});

function requireAdmin(req, res, next) {
  const pass = req.headers["x-admin-password"];
  if (!pass || pass !== ADMIN_PASSWORD) return res.status(401).json({ error: "Senha admin inválida." });
  next();
}

app.get("/api/admin/orders", adminLimiter, requireAdmin, (req, res) => {
  clearExpiredReservations();
  const orders = db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 500").all();
  res.json(orders.map(o => ({
    id: o.id,
    customerName: o.customer_name,
    phone: o.phone,
    email: o.email,
    cpf: o.cpf,
    quantity: o.quantity,
    amountCents: o.amount_cents,
    status: o.status,
    mpStatus: o.mp_status,
    mpPaymentId: o.mp_payment_id,
    numbers: JSON.parse(o.numbers).map(formatNumber),
    createdAt: o.created_at,
    paidAt: o.paid_at
  })));
});

app.post("/api/admin/orders/:id/sync", adminLimiter, requireAdmin, async (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order || !order.mp_payment_id) return res.status(404).json({ error: "Pedido/pagamento não encontrado." });

  const payment = await getMercadoPagoPayment(order.mp_payment_id);
  const result = applyPaymentStatus(payment, req);

  res.json({ ok: true, mpStatus: payment.status, result });
});

app.post("/api/admin/draw", adminLimiter, requireAdmin, (req, res) => {
  const { prize } = req.body;

  const winner = db.prepare(`
    SELECT rn.number, o.customer_name, o.phone, o.email, o.id as order_id
    FROM raffle_numbers rn
    JOIN orders o ON rn.order_id = o.id
    WHERE rn.status = 'paid'
    ORDER BY RANDOM()
    LIMIT 1
  `).get();

  if (!winner) return res.status(400).json({ error: "Ainda não há números pagos para sortear." });

  logEvent("draw", winner.order_id, req, { prize, winnerNumber: winner.number });

  res.json({
    prize: prize || "Prêmio",
    winnerNumber: formatNumber(winner.number),
    customerName: winner.customer_name,
    phone: winner.phone,
    email: winner.email,
    orderId: winner.order_id
  });
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log("");
  console.log("========================================");
  console.log(" Rifa da Sorte Scobar 00 da Serra");
  console.log("========================================");
  console.log(` Site:  http://localhost:${PORT}`);
  console.log(` Admin: http://localhost:${PORT}/admin.html`);
  console.log(` Valor: R$ 0,50 por número`);
  console.log(` Mínimo: 20 números | Total: 300.000 números | Meta: R$ 150.000`);
  console.log(` Mercado Pago: ${MP_ACCESS_TOKEN ? "token configurado" : "TOKEN AUSENTE NO .env"}`);
  console.log("");
});
