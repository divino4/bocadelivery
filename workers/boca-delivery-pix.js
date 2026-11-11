
/**
 * Boca Delivery - Mercado Pago Pix Worker
 * Required Cloudflare secrets:
 *   MP_ACCESS_TOKEN
 *   FIREBASE_SERVICE_ACCOUNT (JSON contents of Firebase service-account key)
 *   MP_WEBHOOK_SECRET
 */
const MP_API = "https://api.mercadopago.com";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const ALLOWED_ORIGIN = "https://divino4.github.io";
let cachedGoogleToken = null;
let cachedGoogleTokenUntil = 0;

function json(data, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "content-type, authorization, x-signature, x-request-id",
      "access-control-max-age": "86400",
      "vary": "Origin"
    }
  });
}
function b64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function utf8b64url(value) {
  return b64url(new TextEncoder().encode(value));
}
function pemToBytes(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "").replace(/\s/g, "");
  const raw = atob(body);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function googleAccessToken(env) {
  if (cachedGoogleToken && Date.now() < cachedGoogleTokenUntil) return cachedGoogleToken;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error("Credencial Firebase incompleta.");
  const now = Math.floor(Date.now() / 1000);
  const header = utf8b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = utf8b64url(JSON.stringify({
    iss: sa.client_email, scope: FIRESTORE_SCOPE,
    aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600
  }));
  const unsigned = header + "." + claim;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToBytes(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = unsigned + "." + b64url(new Uint8Array(signature));
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) throw new Error("Não foi possível autenticar no Firebase.");
  cachedGoogleToken = result.access_token;
  cachedGoogleTokenUntil = Date.now() + Math.max(60, (result.expires_in || 3600) - 120) * 1000;
  return cachedGoogleToken;
}
function fsEncode(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value)
    ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(fsEncode) } };
  if (typeof value === "object") {
    const fields = {};
    for (const [key, item] of Object.entries(value)) fields[key] = fsEncode(item);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}
function fsDecode(value) {
  if (!value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("nullValue" in value) return null;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(fsDecode);
  if ("mapValue" in value) return fsObject(value.mapValue.fields || {});
  return null;
}
function fsObject(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) out[key] = fsDecode(value);
  return out;
}

let cachedFirebaseJwks = null;
let cachedFirebaseJwksUntil = 0;

function decodeJwtPart(part) {
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function firebaseSigningKey(kid) {
  if (!cachedFirebaseJwks || Date.now() >= cachedFirebaseJwksUntil) {
    const response = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
    if (!response.ok) throw new Error("Não foi possível obter as chaves públicas do Firebase.");
    cachedFirebaseJwks = await response.json();
    const cacheControl = response.headers.get("cache-control") || "";
    const maxAge = Number(cacheControl.match(/max-age=(\d+)/i)?.[1] || 3600);
    cachedFirebaseJwksUntil = Date.now() + Math.max(1, Math.min(maxAge, 86400)) * 1000;
  }
  return (cachedFirebaseJwks.keys || []).find(key => key.kid === kid && key.kty === "RSA" && key.use === "sig") || null;
}

async function verifyFirebaseIdToken(request, env) {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9._-]+)$/);
  if (!match) return null;
  const parts = match[1].split(".");
  if (parts.length !== 3) return null;
  let header, claims, signature;
  try {
    header = decodeJwtPart(parts[0]);
    claims = decodeJwtPart(parts[1]);
    const normalized = parts[2].replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    signature = Uint8Array.from(binary, c => c.charCodeAt(0));
  } catch (_) { return null; }
  const projectId = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT).project_id;
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== "RS256" || !header.kid ||
      claims.iss !== "https://securetoken.google.com/" + projectId ||
      claims.aud !== projectId || typeof claims.sub !== "string" ||
      !claims.sub || claims.sub.length > 128 ||
      !Number.isFinite(claims.exp) || claims.exp <= now ||
      !Number.isFinite(claims.iat) || claims.iat > now ||
      !Number.isFinite(claims.auth_time) || claims.auth_time > now) return null;
  const jwk = await firebaseSigningKey(header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature,
    new TextEncoder().encode(parts[0] + "." + parts[1]));
  return valid ? { uid: claims.sub } : null;
}
function cents(value) { return Math.round((Number(value) + Number.EPSILON) * 100); }
function parseExtras(raw) {
  return String(raw || "").split("\n").map(x => x.trim()).filter(Boolean).map(line => {
    const i = line.lastIndexOf(":");
    if (i < 0) return { name: line, price: 0 };
    return { name: line.slice(0, i).trim(), price: Number(line.slice(i + 1).trim().replace(",", ".")) };
  });
}
async function firestoreRequest(env, path, options = {}) {
  const token = await googleAccessToken(env);
  const response = await fetch("https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT).project_id) +
    "/databases/(default)/documents/" + path, {
      ...options,
      headers: { authorization: "Bearer " + token, "content-type": "application/json", ...(options.headers || {}) }
    });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Firestore HTTP " + response.status + ": " + (body.error?.message || "erro"));
  return body;
}
async function getDoc(env, collection, id) {
  try {
    const doc = await firestoreRequest(env, collection + "/" + encodeURIComponent(id));
    return fsObject(doc.fields || {});
  } catch (error) {
    if (String(error.message).includes("HTTP 404")) return null;
    throw error;
  }
}
async function patchDoc(env, collection, id, patch) {
  const fields = {};
  for (const [key, value] of Object.entries(patch)) fields[key] = fsEncode(value);
  const params = Object.keys(patch).map(k => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  return firestoreRequest(env, collection + "/" + encodeURIComponent(id) + "?" + params, {
    method: "PATCH", body: JSON.stringify({ fields })
  });
}

async function getDocSnapshot(env, collection, id) {
  try {
    const doc = await firestoreRequest(env, collection + "/" + encodeURIComponent(id));
    return { data: fsObject(doc.fields || {}), updateTime: doc.updateTime || null };
  } catch (error) {
    if (String(error.message).includes("HTTP 404")) return null;
    throw error;
  }
}

async function patchDocIfUnchanged(env, collection, id, updateTime, patch) {
  if (!updateTime) throw new Error("Firestore não retornou updateTime para proteção concorrente.");
  const fields = {};
  for (const [key, value] of Object.entries(patch)) fields[key] = fsEncode(value);
  const projectId = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT).project_id;
  const token = await googleAccessToken(env);
  const documentName = "projects/" + projectId + "/databases/(default)/documents/" +
    collection + "/" + encodeURIComponent(id);
  const response = await fetch("https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(projectId) + "/databases/(default)/documents:commit", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ writes: [{
        update: { name: documentName, fields },
        updateMask: { fieldPaths: Object.keys(patch) },
        currentDocument: { updateTime }
      }] })
    });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (body.error?.status === "FAILED_PRECONDITION" || response.status === 409) return false;
    throw new Error("Firestore commit HTTP " + response.status + ": " + (body.error?.message || "erro"));
  }
  return true;
}
async function createOrPatchDoc(env, collection, id, data) {
  const existing = await getDoc(env, collection, id);
  if (existing) return patchDoc(env, collection, id, data);
  const fields = {};
  for (const [key, value] of Object.entries(data)) fields[key] = fsEncode(value);
  const projectId = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT).project_id;
  const token = await googleAccessToken(env);
  const response = await fetch("https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(projectId) + "/databases/(default)/documents/" +
    collection + "?documentId=" + encodeURIComponent(id), {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ fields })
    });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 409) throw new Error("Firestore create HTTP " + response.status);
  if (response.status === 409) return patchDoc(env, collection, id, data);
  return body;
}
async function calculateOrder(env, order) {
  if (!Array.isArray(order.itens) || order.itens.length < 1 || order.itens.length > 50) throw new Error("O pedido não possui itens válidos.");
  const cfg = await getDoc(env, "cfg", "loja") || {};
  let subtotalCents = 0;
  const verifiedItems = [];
  for (const line of order.itens) {
    const productId = String(line.produtoId || "");
    const qty = Number(line.qtd);
    if (!productId || !Number.isInteger(qty) || qty < 1 || qty > 30) throw new Error("Há um item inválido no pedido.");
    const product = await getDoc(env, "menu", productId);
    if (!product || product.ativo === false) throw new Error("Um produto do pedido não está mais disponível.");
    const baseCents = cents(product.preco);
    if (!Number.isSafeInteger(baseCents) || baseCents < 0) throw new Error("Preço inválido no cardápio.");
    const available = parseExtras(product.extras);
    const selected = Array.isArray(line.extras) ? line.extras : [];
    if (selected.length > 20) throw new Error("Quantidade de adicionais inválida.");
    let extrasCents = 0;
    for (const name of selected) {
      const extra = available.find(x => x.name === String(name));
      if (!extra || !Number.isFinite(extra.price) || extra.price < 0) throw new Error("Um adicional não é válido para este produto.");
      extrasCents += cents(extra.price);
    }
    const unitCents = baseCents + extrasCents;
    subtotalCents += unitCents * qty;
    verifiedItems.push({
      produtoId: productId, nome: String(product.nome || "").slice(0, 120),
      qtd: qty, preco: unitCents / 100, extras: selected.map(String),
      obs: String(line.obs || "").slice(0, 300)
    });
  }
  let discountCents = 0;
  const couponCode = String(order.cupom || "").trim().toUpperCase();
  if (couponCode) {
    const coupon = await getDoc(env, "cupons", couponCode);
    if (!coupon || coupon.ativo !== true) throw new Error("O cupom deste pedido não é mais válido.");
    if (subtotalCents < cents(coupon.min || 0)) throw new Error("O pedido não alcança o valor mínimo do cupom.");
    discountCents = coupon.tipo === "%" ? Math.round(subtotalCents * Number(coupon.valor) / 100) : cents(coupon.valor);
    if (!Number.isSafeInteger(discountCents) || discountCents < 0) throw new Error("Desconto do cupom inválido.");
    discountCents = Math.min(discountCents, subtotalCents);
  }
  let deliveryCents = 0;
  if (order.tipo === "entrega") {
    const regionName = String(order.regiao || order.cidade || "");
    const region = (Array.isArray(cfg.cidades) ? cfg.cidades : []).find(x => x.nome === regionName && x.ativo === true);
    if (!region) throw new Error("A região de entrega não está disponível.");
    deliveryCents = cents(region.taxa || 0);
    if (!Number.isSafeInteger(deliveryCents) || deliveryCents < 0) throw new Error("Taxa de entrega inválida.");
  } else if (order.tipo !== "retirada") throw new Error("Tipo de pedido inválido.");
  const totalCents = subtotalCents - discountCents + deliveryCents;
  if (totalCents <= 0) throw new Error("O total do pedido precisa ser maior que zero.");
  return { itens: verifiedItems, subtotal: subtotalCents / 100, desconto: discountCents / 100, taxa: deliveryCents / 100, total: totalCents / 100 };
}
async function mpRequest(env, path, options = {}) {
  const response = await fetch(MP_API + path, {
    ...options,
    headers: { authorization: "Bearer " + env.MP_ACCESS_TOKEN, "content-type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Mercado Pago API error", response.status, body);
    throw new Error("Mercado Pago retornou HTTP " + response.status + ".");
  }
  return body;
}
async function createPix(request, env) {
  const input = await request.json();
  const orderId = String(input.orderId || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  if (!/^[A-Za-z0-9_-]{5,80}$/.test(orderId)) return json({ error: "Identificador do pedido inválido." }, 400);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Informe um e-mail válido." }, 400);
  const identity = await verifyFirebaseIdToken(request, env);
  if (!identity) return json({ error: "Autenticação necessária. Atualize sua sessão e tente novamente." }, 401);
  const order = await getDoc(env, "orders", orderId);
  if (!order) return json({ error: "Pedido não encontrado." }, 404);
  if (String(order.ownerUid || "") !== identity.uid) return json({ error: "Este pedido não pertence à conta autenticada." }, 403);
  if (order.pag !== "Pix") return json({ error: "Este pedido não foi feito com Pix." }, 400);
  if (order.pago === true) return json({ paid: true });
  if (["cancelado", "entregue"].includes(order.status)) return json({ error: "Este pedido não aceita mais pagamento." }, 400);

  if (order.pixPaymentId) {
    const previous = await mpRequest(env, "/v1/payments/" + encodeURIComponent(order.pixPaymentId), { method: "GET" });
    if (previous.status === "approved") {
      const previousOrderId = String(previous.external_reference || "");
      const previousMetadataOrderId = String(previous.metadata?.order_id || "");
      const previousAttemptId = String(previous.metadata?.pix_attempt_id || "");
      if (previousOrderId !== orderId || previousMetadataOrderId !== orderId ||
          previous.currency_id !== "BRL" || previous.payment_method_id !== "pix" ||
          !order.pixAttemptId || previousAttemptId !== String(order.pixAttemptId) ||
          cents(previous.transaction_amount) !== cents(order.total)) {
        return json({ error: "A cobrança Pix aprovada não corresponde aos dados atuais do pedido. A loja deverá verificar o pagamento." }, 409);
      }
      await patchDoc(env, "orders", orderId, {
        pago: true, pixStatus: "approved", pixApprovedAt: new Date().toISOString()
      });
      return json({ paid: true });
    }
    const expiry = Date.parse(order.pixExpiresAt || "");
    if (expiry > Date.now() && order.pixQrCode) {
      return json({ reused: true, qrCode: order.pixQrCode, qrCodeBase64: order.pixQrBase64 || null, ticketUrl: order.pixTicketUrl || null });
    }
    if (["pending", "in_process", "authorized"].includes(previous.status) && expiry <= Date.now()) {
      return json({ error: "O Pix anterior ainda consta em processamento. Aguarde a atualização." }, 409);
    }
  }

  const verified = await calculateOrder(env, order);
  const latest = await getDocSnapshot(env, "orders", orderId);
  if (!latest) return json({ error: "Pedido não encontrado." }, 404);
  if (String(latest.data.ownerUid || "") !== identity.uid) return json({ error: "Este pedido não pertence à conta autenticada." }, 403);
  if (latest.data.pago === true) return json({ paid: true });
  const creatingAt = Date.parse(latest.data.pixCreatingAt || "");
  if (latest.data.pixStatus === "creating" && Number.isFinite(creatingAt) && Date.now() - creatingAt < 120000) {
    return json({ error: "Já estamos processando o Pix deste pedido. Aguarde alguns instantes." }, 409);
  }
  const attemptId = latest.data.pixAttemptId && !latest.data.pixPaymentId &&
    ["error", "creating"].includes(latest.data.pixStatus) ? latest.data.pixAttemptId : crypto.randomUUID();
  const claimed = await patchDocIfUnchanged(env, "orders", orderId, latest.updateTime, {
    subtotal: verified.subtotal, desconto: verified.desconto, taxa: verified.taxa,
    total: verified.total, itens: verified.itens, pixAttemptId: attemptId,
    pixStatus: "creating", pixEmail: email, pixCreatingAt: new Date().toISOString()
  });
  if (!claimed) return json({ error: "O pedido foi atualizado por outra solicitação. Tente novamente." }, 409);
  try {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const payment = await mpRequest(env, "/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": attemptId },
      body: JSON.stringify({
        transaction_amount: verified.total,
        description: "Pedido " + orderId + " - Boca Delivery",
        payment_method_id: "pix", payer: { email },
        external_reference: orderId,
        notification_url: new URL("/webhook", request.url).toString(),
        date_of_expiration: expiresAt,
        metadata: { order_id: orderId, pix_attempt_id: attemptId }
      })
    });
    const tx = payment.point_of_interaction?.transaction_data || {};
    if (!payment.id || !tx.qr_code) throw new Error("Mercado Pago não retornou o QR Code Pix.");
    const afterPayment = await getDocSnapshot(env, "orders", orderId);
    if (!afterPayment || afterPayment.data.pixAttemptId !== attemptId) {
      return json({ error: "O Pix foi criado, mas o pedido mudou durante o processamento. Entre em contato com a loja." }, 409);
    }
    const saved = await patchDocIfUnchanged(env, "orders", orderId, afterPayment.updateTime, {
      pixPaymentId: String(payment.id), pixQrCode: tx.qr_code,
      pixQrBase64: tx.qr_code_base64 || null, pixTicketUrl: tx.ticket_url || null,
      pixExpiresAt: expiresAt, pixStatus: payment.status || "pending",
      pixUpdatedAt: new Date().toISOString()
    });
    if (!saved) return json({ error: "O Pix foi criado, mas não foi possível atualizar o pedido. Tente consultar novamente." }, 409);
    return json({ paymentId: String(payment.id), qrCode: tx.qr_code, qrCodeBase64: tx.qr_code_base64 || null, ticketUrl: tx.ticket_url || null });
  } catch (error) {
    const failedSnapshot = await getDocSnapshot(env, "orders", orderId).catch(() => null);
    if (failedSnapshot && failedSnapshot.data.pixAttemptId === attemptId && failedSnapshot.data.pixStatus === "creating") {
      await patchDocIfUnchanged(env, "orders", orderId, failedSnapshot.updateTime, {
        pixStatus: "error", pixErrorAt: new Date().toISOString()
      }).catch(() => false);
    }
    console.error("createPix failed", orderId, error);
    return json({ error: "Não foi possível gerar o Pix agora. Tente novamente em instantes." }, 502);
  }
}
async function validWebhookSignature(request, dataId, env) {
  const secret = env.MP_WEBHOOK_SECRET;
  const signature = request.headers.get("x-signature") || "";
  const requestId = request.headers.get("x-request-id") || "";
  const parts = Object.fromEntries(signature.split(",").map(x => x.trim().split("=").map(v => v.trim())));
  if (!secret || !parts.ts || !parts.v1 || !requestId || !dataId) return false;
  const manifest = "id:" + String(dataId).toLowerCase() + ";request-id:" + requestId + ";ts:" + parts.ts + ";";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest));
  const expected = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  return expected.length === parts.v1.length && expected === parts.v1;
}
async function webhook(request, env) {
  if (!["POST", "GET"].includes(request.method)) return new Response("Method not allowed", { status: 405 });
  const url = new URL(request.url);
  let body = {};
  if (request.method === "POST") body = await request.clone().json().catch(() => ({}));
  const dataId = String(url.searchParams.get("data.id") || body.data?.id || "").trim();
  const type = String(url.searchParams.get("type") || body.type || "");
  if (type && type !== "payment") return new Response("ignored", { status: 200 });
  if (!await validWebhookSignature(request, dataId, env)) return new Response("Invalid signature", { status: 401 });
  try {
    const payment = await mpRequest(env, "/v1/payments/" + encodeURIComponent(dataId), { method: "GET" });
    const orderId = String(payment.external_reference || "");
    const metadataOrderId = String(payment.metadata?.order_id || "");
    if (!orderId || metadataOrderId !== orderId ||
        payment.currency_id !== "BRL" || payment.payment_method_id !== "pix") return new Response("ignored", { status: 200 });
    const order = await getDoc(env, "orders", orderId);
    if (!order) return new Response("ok", { status: 200 });
    const attemptId = String(payment.metadata?.pix_attempt_id || "");
    if (!attemptId || order.pixAttemptId !== attemptId || cents(payment.transaction_amount) !== cents(order.total)) return new Response("ok", { status: 200 });
    if (order.pixPaymentId && String(order.pixPaymentId) !== String(payment.id)) return new Response("ok", { status: 200 });
    const patch = { pixStatus: String(payment.status || "pending"), pixPaymentId: String(payment.id), pixUpdatedAt: new Date().toISOString() };
    if (payment.status === "approved" && order.pago !== true) {
      patch.pago = true;
      patch.pixApprovedAt = new Date().toISOString();
      const audit = {
        orderId, action: "mercado_pago_pix_aprovado", paymentId: String(payment.id),
        amount: Number(payment.transaction_amount), actor: "mercado_pago_webhook",
        ts: new Date().toISOString()
      };
      await createOrPatchDoc(env, "audit", "mp_" + String(payment.id), audit);
    }
    if (order.pago !== true || payment.status === "approved") await patchDoc(env, "orders", orderId, patch);
    return new Response("ok", { status: 200 });
  } catch (error) {
    console.error("Webhook failed", error);
    return new Response("Webhook processing failed", { status: 500 });
  }
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    if (request.method === "OPTIONS") return new Response(null, {
      status: 204, headers: {
        "access-control-allow-origin": origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
        "access-control-allow-methods": "POST, GET, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, x-signature, x-request-id",
        "access-control-max-age": "86400", "vary": "Origin"
      }
    });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        try {
          await getDoc(env, "cfg", "loja");
          return json({ ok: true, firebase: "connected" });
        } catch (error) {
          console.error("Health check failed", error);
          return json({ ok: false, firebase: "unavailable" }, 503);
        }
      }
      if (url.pathname === "/create-pix" && request.method === "POST") return await createPix(request, env);
      if (url.pathname === "/webhook") return await webhook(request, env);
      if (url.pathname === "/" && request.method === "GET") return new Response("Boca Delivery Pix Worker", { status: 200 });
      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("Worker error", error);
      return json({ error: "Erro interno ao processar o Pix." }, 500);
    }
  }
};