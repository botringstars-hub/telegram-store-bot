import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Telegraf, Markup } from "telegraf";

const cfg = {
  port: Number(process.env.PORT || 3000),
  token: process.env.TELEGRAM_BOT_TOKEN || "",
  adminIds: new Set((process.env.TELEGRAM_ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean)),
  adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || "",
  baseUrl: (process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/$/, ""),
  dataPath: process.env.DATA_PATH || "./data/store.json",
  adminUser: process.env.ADMIN_USERNAME || "admin",
  adminPass: process.env.ADMIN_PASSWORD || "change-me",
  jwtSecret: process.env.JWT_SECRET || "change-this-before-production",
  demo: (process.env.DEMO_MODE || "true").toLowerCase() === "true",
  midtransKey: process.env.MIDTRANS_SERVER_KEY || "",
  midtransProduction: (process.env.MIDTRANS_IS_PRODUCTION || "false").toLowerCase() === "true"
};

const seed = {
  products: [{
    id: "demo-1",
    name: "Produk Digital Demo",
    description: "Contoh produk untuk pengujian bot",
    price: 15000,
    active: true,
    stock: ["DEMO-AKUN-001", "DEMO-AKUN-002"]
  }],
  promos: [{ code: "HEMAT10", percent: 10, active: true }],
  users: {},
  orders: [],
  settings: { resellerPercent: 5 }
};
let db;
function save() {
  fs.mkdirSync(path.dirname(cfg.dataPath), { recursive: true });
  fs.writeFileSync(cfg.dataPath, JSON.stringify(db, null, 2));
}
function init() {
  try { db = JSON.parse(fs.readFileSync(cfg.dataPath, "utf8")); }
  catch { db = structuredClone(seed); save(); }
  db.products ||= [];
  db.promos ||= [];
  db.users ||= {};
  db.orders ||= [];
  db.settings ||= { resellerPercent: 5 };
}
function userFor(tg, ref = "") {
  const id = String(tg.id);
  if (!db.users[id]) {
    db.users[id] = {
      id,
      username: tg.username || "",
      name: [tg.first_name, tg.last_name].filter(Boolean).join(" "),
      refCode: "RS" + id.slice(-6),
      referredBy: null,
      commission: 0
    };
    const owner = Object.values(db.users).find(u => u.refCode === ref && u.id !== id);
    if (owner) db.users[id].referredBy = owner.id;
    save();
  }
  return db.users[id];
}
function makeOrder(userId, productId, promoText) {
  const product = db.products.find(p => p.id === productId && p.active);
  if (!product || !product.stock?.length) throw Error("Produk tidak tersedia atau stok habis");
  const promo = db.promos.find(p => p.active && p.code === String(promoText || "").toUpperCase());
  const discount = promo ? Math.round(product.price * promo.percent / 100) : 0;
  const order = {
    id: "INV-" + Date.now() + "-" + crypto.randomBytes(2).toString("hex").toUpperCase(),
    userId: String(userId),
    productId,
    productName: product.name,
    subtotal: product.price,
    discount,
    total: product.price - discount,
    promoCode: promo?.code || null,
    status: "pending",
    createdAt: new Date().toISOString(),
    payToken: crypto.randomBytes(18).toString("hex"),
    delivery: null
  };
  db.orders.unshift(order);
  save();
  return order;
}
function paid(orderId) {
  const order = db.orders.find(o => o.id === orderId);
  if (!order) throw Error("Pesanan tidak ditemukan");
  if (order.status === "paid") return order;
  const product = db.products.find(p => p.id === order.productId);
  if (!product?.stock?.length) throw Error("Stok habis. Hubungi admin.");
  order.delivery = product.stock.shift();
  order.status = "paid";
  order.paidAt = new Date().toISOString();
  const buyer = db.users[order.userId];
  const reseller = buyer?.referredBy && db.users[buyer.referredBy];
  if (reseller) {
    const fee = Math.round(order.total * Number(db.settings.resellerPercent || 0) / 100);
    reseller.commission += fee;
    order.resellerCommission = fee;
  }
  save();
  return order;
}
const rupiah = n => new Intl.NumberFormat("id-ID", {
  style: "currency", currency: "IDR", maximumFractionDigits: 0
}).format(n);

async function snap(order) {
  if (!cfg.midtransKey) return null;
  const host = cfg.midtransProduction ? "https://app.midtrans.com" : "https://app.sandbox.midtrans.com";
  const response = await fetch(host + "/snap/v1/transactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(cfg.midtransKey + ":").toString("base64")
    },
    body: JSON.stringify({
      transaction_details: { order_id: order.id, gross_amount: order.total },
      item_details: [{
        id: order.productId, price: order.total, quantity: 1, name: order.productName.slice(0, 50)
      }]
    })
  });
  if (!response.ok) throw Error("Midtrans gagal: " + await response.text());
  return response.json();
}
function validMidtrans(body) {
  const raw = String(body.order_id) + String(body.status_code) +
    String(body.gross_amount) + cfg.midtransKey;
  const expected = crypto.createHash("sha512").update(raw).digest("hex");
  return expected === body.signature_key;
}
function midtransPaid(body) {
  return body.transaction_status === "settlement" ||
    (body.transaction_status === "capture" && body.fraud_status === "accept");
}

init();
const pending = new Map();
const bot = cfg.token ? new Telegraf(cfg.token) : null;

async function sendDelivery(order) {
  if (!bot) return;
  const safe = String(order.delivery).replace(/[<>&]/g, "");
  await bot.telegram.sendMessage(
    order.userId,
    "✅ Pembayaran diterima\nPesanan: " + order.id +
      "\nProduk: " + order.productName +
      "\n\nData akun/kode:\n<code>" + safe +
      "</code>\n\nSimpan data ini dan segera ubah kata sandi jika tersedia.",
    { parse_mode: "HTML" }
  );
  if (cfg.adminChatId) {
    await bot.telegram.sendMessage(
      cfg.adminChatId,
      "💰 Transaksi berhasil\n" + order.id + "\n" +
        order.productName + "\n" + rupiah(order.total)
    );
  }
}
async function showCatalog(ctx) {
  const products = db.products.filter(p => p.active);
  if (!products.length) return ctx.reply("Katalog masih kosong.");
  const buttons = products.map(p => [
    Markup.button.callback(p.name + " • " + rupiah(p.price), "product:" + p.id)
  ]);
  return ctx.reply("🛍 Pilih produk:", Markup.inlineKeyboard(buttons));
}
if (bot) {
  bot.start(async ctx => {
    const ref = ctx.message.text.split(/\s+/)[1] || "";
    const user = userFor(ctx.from, ref);
    await ctx.reply(
      "Selamat datang di Ringstars Store.\nKode reseller Anda: " + user.refCode,
      Markup.inlineKeyboard([
        [Markup.button.callback("🛍 Katalog", "catalog")],
        [Markup.button.callback("📦 Pesanan Saya", "orders")]
      ])
    );
  });
  bot.command("katalog", showCatalog);
  bot.action("catalog", async ctx => {
    await ctx.answerCbQuery();
    await showCatalog(ctx);
  });
  bot.action(/^product:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const p = db.products.find(x => x.id === ctx.match[1] && x.active);
    if (!p) return ctx.reply("Produk tidak tersedia.");
    await ctx.reply(
      "📦 " + p.name + "\n" + p.description +
        "\nHarga: " + rupiah(p.price) + "\nStok: " + p.stock.length,
      Markup.inlineKeyboard([
        [Markup.button.callback("Beli", "buy:" + p.id)],
        [Markup.button.callback("Kembali", "catalog")]
      ])
    );
  });
  bot.action(/^buy:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    pending.set(String(ctx.from.id), ctx.match[1]);
    await ctx.reply("Kirim kode promo, atau ketik tanda - jika tidak ada.");
  });
  bot.action("orders", async ctx => {
    await ctx.answerCbQuery();
    const orders = db.orders.filter(o => o.userId === String(ctx.from.id)).slice(0, 10);
    await ctx.reply(
      orders.length
        ? orders.map(o => o.id + " • " + o.status + " • " + rupiah(o.total)).join("\n")
        : "Belum ada pesanan."
    );
  });
  bot.command("admin", async ctx => {
    if (!cfg.adminIds.has(String(ctx.from.id))) return;
    await ctx.reply(
      "Produk: " + db.products.length +
      "\nPesanan: " + db.orders.length +
      "\nLunas: " + db.orders.filter(o => o.status === "paid").length
    );
  });
  bot.on("text", async ctx => {
    const userId = String(ctx.from.id);
    const productId = pending.get(userId);
    if (!productId || ctx.message.text.startsWith("/")) return;
    pending.delete(userId);
    userFor(ctx.from);
    try {
      const promo = ctx.message.text.trim() === "-" ? "" : ctx.message.text.trim();
      const order = makeOrder(userId, productId, promo);
      const payment = await snap(order);
      const url = payment?.redirect_url ||
        (cfg.demo ? cfg.baseUrl + "/demo/pay/" + encodeURIComponent(order.id) +
          "?token=" + order.payToken : "");
      const text = "🧾 " + order.id + "\nTotal: " + rupiah(order.total) +
        (order.discount ? "\nDiskon: " + rupiah(order.discount) : "");
      if (!url) return ctx.reply(text + "\nPembayaran belum dikonfigurasi.");
      await ctx.reply(
        text,
        Markup.inlineKeyboard([[
          Markup.button.url(payment ? "Bayar Sekarang" : "Simulasikan Pembayaran", url)
        ]])
      );
    } catch (error) {
      await ctx.reply("Gagal membuat pesanan: " + error.message);
    }
  });
  bot.catch(error => console.error("Telegram error:", error));
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static("public"));

function adminOnly(req, res, next) {
  try {
    jwt.verify(req.cookies.admin_token || "", cfg.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: "Silakan login" });
  }
}
app.get("/", (_req, res) => res.redirect("/admin"));
app.get("/admin", (_req, res) => res.sendFile(path.resolve("public/admin.html")));
app.get("/health", (_req, res) => res.json({
  ok: true, botConfigured: Boolean(cfg.token), demoMode: cfg.demo
}));
app.post("/api/login", (req, res) => {
  if (String(req.body.username) !== cfg.adminUser ||
      String(req.body.password) !== cfg.adminPass) {
    return res.status(401).json({ error: "Username atau password salah" });
  }
  const token = jwt.sign({ role: "admin" }, cfg.jwtSecret, { expiresIn: "12h" });
  res.cookie("admin_token", token, {
    httpOnly: true,
    secure: cfg.baseUrl.startsWith("https"),
    sameSite: "lax"
  }).json({ ok: true });
});
app.post("/api/logout", (_req, res) =>
  res.clearCookie("admin_token").json({ ok: true })
);
app.get("/api/admin/state", adminOnly, (_req, res) => res.json({
  products: db.products,
  promos: db.promos,
  orders: db.orders.slice(0, 100),
  users: Object.values(db.users),
  settings: db.settings
}));
app.post("/api/admin/products", adminOnly, (req, res) => {
  const id = String(req.body.id || "p-" + Date.now());
  let product = db.products.find(p => p.id === id);
  const data = {
    id,
    name: String(req.body.name || "").trim(),
    description: String(req.body.description || "").trim(),
    price: Math.max(0, Number(req.body.price || 0)),
    active: req.body.active !== false
  };
  if (!data.name) return res.status(400).json({ error: "Nama produk wajib diisi" });
  if (product) Object.assign(product, data);
  else {
    product = { ...data, stock: [] };
    db.products.push(product);
  }
  save();
  res.json(product);
});
app.post("/api/admin/stock/:id", adminOnly, (req, res) => {
  const product = db.products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: "Produk tidak ditemukan" });
  const items = String(req.body.items || "").split("\n").map(x => x.trim()).filter(Boolean);
  product.stock.push(...items);
  save();
  res.json({ ok: true, stock: product.stock.length });
});
app.post("/api/admin/promos", adminOnly, (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Kode wajib diisi" });
  let promo = db.promos.find(p => p.code === code);
  const data = {
    code,
    percent: Math.min(100, Math.max(0, Number(req.body.percent || 0))),
    active: true
  };
  if (promo) Object.assign(promo, data);
  else {
    promo = data;
    db.promos.push(promo);
  }
  save();
  res.json(promo);
});
app.post("/api/admin/settings", adminOnly, (req, res) => {
  db.settings.resellerPercent = Math.min(100, Math.max(0,
    Number(req.body.resellerPercent || 0)));
  save();
  res.json(db.settings);
});
app.get("/demo/pay/:id", async (req, res) => {
  if (!cfg.demo) return res.status(404).send("Mode demo dinonaktifkan.");
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order || order.payToken !== req.query.token) {
    return res.status(403).send("Tautan pembayaran tidak valid.");
  }
  try {
    const done = paid(order.id);
    await sendDelivery(done);
    res.send("<meta name='viewport' content='width=device-width'><h2>Pembayaran demo berhasil</h2><p>Kembali ke Telegram untuk menerima produk.</p>");
  } catch (error) {
    res.status(400).send(error.message);
  }
});
app.post("/payments/midtrans/notification", async (req, res) => {
  if (!cfg.midtransKey || !validMidtrans(req.body)) {
    return res.status(403).json({ error: "Signature tidak valid" });
  }
  try {
    if (midtransPaid(req.body)) {
      const done = paid(req.body.order_id);
      await sendDelivery(done);
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(400).json({ error: error.message });
});

app.listen(cfg.port, "0.0.0.0", async () => {
  console.log("Server berjalan pada port", cfg.port);
  if (!bot) return console.warn("TELEGRAM_BOT_TOKEN belum diisi.");
  try {
    await bot.launch({ dropPendingUpdates: true });
    console.log("Telegram bot aktif.");
  } catch (error) {
    console.error("Bot gagal aktif:", error.message);
  }
});
const stop = () => {
  bot?.stop();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
