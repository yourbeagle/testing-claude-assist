import 'dotenv/config';
import crypto from 'crypto';
import WebSocket from 'ws';
import * as _forge from 'node-forge';
import { initializeConfig, createOrderProposal } from '@temple-digital-group/temple-canton-js';

const forge = _forge.default || _forge;
const API = 'https://api.templedigitalgroup.com';
const LOOP = 'https://cantonloop.com';

const cfg = {
  network: env('NETWORK', 'mainnet'),
  symbol: env('SYMBOL', 'Amulet/USDCx'),
  partyId: must('PARTY_ID'),
  email: must('EMAIL'),
  password: must('PASSWORD'),
  qty: num('TRADE_QTY', 40),
  sellQty: num('SELL_QTY', 40),
  ccReserve: num('CC_RESERVE', 10),
  ccFixedReserve: num('CC_FIXED_RESERVE', 50),
  sellBalancePct: num('SELL_BALANCE_PCT', 0.5),
  buyBalancePct: num('BUY_BALANCE_PCT', 0.5),
  buyCapCc: num('BUY_CAP_CC', 36),
  maxOrdersPerSide: num('MAX_ORDERS_PER_SIDE', 0),
  minOrderQty: num('MIN_ORDER_QTY', 35),
  tick: num('TICK_SIZE', 0.0001),
  pollMs: num('POLL_MS', 500),
  monitorMs: num('ORDER_MONITOR_MS', 1000),
  heartbeatMs: num('LOG_HEARTBEAT_MS', 10000),
  cooldownMs: num('REPLACE_COOLDOWN_MS', 15000),
  replaceIfDriftTicks: num('REPLACE_IF_DRIFT_TICKS', 1),
  repriceGapTicks: num('REPRICE_GAP_TICKS', 2),
  cancelRetryWaitMs: num('CANCEL_RETRY_WAIT_MS', 60000),
  maxOrderAgeMs: num('MAX_ORDER_AGE_MS', 180000),
  waitAppearMs: num('WAIT_APPEAR_MS', 120000),
  pendingHardTimeoutMs: num('PENDING_HARD_TIMEOUT_MS', 600000),
  waitDisappearMs: num('WAIT_DISAPPEAR_MS', 120000),
  rateLimitBackoffMs: num('RATE_LIMIT_BACKOFF_MS', 70000),
  mergePauseMs: num('MERGE_PAUSE_MS', 180000),
  minCcRemain: num('MIN_CC_REMAIN', 5),
  minUsdcRemain: num('MIN_USDCX_REMAIN', 1),
  dryRun: bool('DRY_RUN', true),
  runOnce: bool('RUN_ONCE', false),
  forceSide: env('FORCE_SIDE', '').toLowerCase(),
};

const state = {
  inFlight: false,
  lastActionAt: 0,
  templeToken: null,
  templeTokenAt: 0,
  templeLoginPayload: null,
  loopSession: null,
  loopSessionAt: 0,
  disclosures: null,
  disclosuresAt: 0,
  wsOracle: null,
  lastMarket: null,
  lastOracle: null,
  lastBid: null,
  lastAsk: null,
  lastHeartbeatAt: 0,
  knownOrders: new Map(),
  pendingOrder: null,
  rateLimitUntil: 0,
  sidePauseUntil: { buy: 0, sell: 0 },
  nextRepriceAt: { buy: 0, sell: 0 },
  dynamicMinQty: null,
  dynamicMinQtyAt: 0,
};

const signer = makeSigner(parsePrivateKey(), cfg.partyId);

function env(k, d = '') { return process.env[k]?.trim() || d; }
function must(k) {
  const v = env(k);
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
}
function bool(k, d = false) {
  const v = process.env[k];
  if (v == null) return d;
  return String(v).toLowerCase() === 'true';
}
function num(k, d) {
  const v = process.env[k];
  if (v == null || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number ${k}=${v}`);
  return n;
}
function round4(n) { return Number(n.toFixed(4)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function now() { return Date.now(); }
function ts() { return new Date().toISOString(); }
function log(msg, data = null) {
  if (data == null) return console.log(`[${ts()}] ${msg}`);
  return console.log(`[${ts()}] ${msg}`, data);
}
function ffetch(url, opts = {}, timeoutMs = 20000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
}
function sideLower(side) { return String(side || '').toLowerCase(); }
function inRateLimitBackoff() { return now() < state.rateLimitUntil; }
function sidePaused(side) { return now() < (state.sidePauseUntil[sideLower(side)] || 0); }

function parsePrivateKey() {
  const raw = (process.env.PRIVATE_KEYS || process.env.PRIVATE_KEY || '').trim();
  if (!raw) throw new Error('Missing PRIVATE_KEYS/PRIVATE_KEY');
  if (raw.startsWith('[')) return String(JSON.parse(raw)[0] || '').trim();
  if (raw.includes(',')) return raw.split(',')[0].trim();
  return raw;
}

function makeSigner(privateKeyHex, partyId) {
  const privateKey = forge.util.hexToBytes(privateKeyHex);
  const publicKey = forge.pki.ed25519.publicKeyFromPrivateKey({ privateKey });
  const publicKeyHex = forge.util.bytesToHex(publicKey);
  return {
    partyId,
    publicKeyHex,
    signMessageAsHex: (message) => forge.util.bytesToHex(forge.pki.ed25519.sign({ message, encoding: 'utf8', privateKey })),
    signTransactionHash: (txHashB64) => forge.util.bytesToHex(forge.pki.ed25519.sign({ message: forge.util.decode64(txHashB64), encoding: 'binary', privateKey })),
  };
}

async function templeLogin() {
  if (state.templeToken && now() - state.templeTokenAt < 10 * 60_000) return state.templeToken;
  const r = await ffetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: cfg.email, password: cfg.password }),
  });
  const txt = await r.text();
  const js = txt ? JSON.parse(txt) : {};
  if (!r.ok || !js.access_token) throw new Error(`Temple login failed: ${r.status}`);
  state.templeToken = js.access_token;
  state.templeTokenAt = now();
  state.templeLoginPayload = js;
  return state.templeToken;
}

async function templeFetch(path, { method = 'GET', query = null, body = null } = {}) {
  const token = await templeLogin();
  const u = new URL(`${API}${path}`);
  if (query) Object.entries(query).forEach(([k, v]) => v != null && u.searchParams.set(k, String(v)));
  const r = await ffetch(u, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  const js = txt ? JSON.parse(txt) : {};
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${txt.slice(0, 180)}`);
  return js;
}

async function getLoopSession() {
  if (state.loopSession && now() - state.loopSessionAt < 4 * 60_000) return state.loopSession;
  let epoch = Date.now();
  for (let i = 0; i < 3; i++) {
    const signature = signer.signMessageAsHex(`Exchange API Key for ${cfg.partyId}\nTimestamp: ${epoch}`);
    const r = await ffetch(`${LOOP}/api/v1/.connect/pair/apikey`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ public_key: signer.publicKeyHex, signature, epoch }),
    });
    const txt = await r.text();
    if (r.ok) {
      state.loopSession = JSON.parse(txt);
      state.loopSessionAt = now();
      return state.loopSession;
    }
    if (txt.includes('expired epoch')) {
      const o = await ffetch(`${LOOP}/api/v1/.connect/pair/apikey`, { method: 'OPTIONS' });
      epoch = new Date(o.headers.get('date')).getTime();
      continue;
    }
    throw new Error(`Loop apikey failed: ${r.status} ${txt.slice(0, 160)}`);
  }
  throw new Error('Loop apikey failed after retries');
}

async function getBalances() {
  const fetchHoldings = async () => {
    const s = await getLoopSession();
    const r = await ffetch(`${LOOP}/api/v1/.connect/pair/account/holding`, {
      headers: { Authorization: `Bearer ${s.auth_token}` },
    });
    const txt = await r.text();
    const holdings = txt ? JSON.parse(txt) : [];
    if (!r.ok) throw new Error(`Loop holding failed: ${r.status}`);
    return holdings;
  };

  let holdings;
  try {
    holdings = await fetchHoldings();
  } catch (e) {
    // refresh loop session once and retry
    state.loopSession = null;
    state.loopSessionAt = 0;
    holdings = await fetchHoldings();
  }

  const pick = (id) => (holdings || []).find((h) => String(h?.instrument_id?.id || '').toUpperCase() === id.toUpperCase());
  const cc = Number(pick('Amulet')?.total_unlocked_coin || 0);
  const usdcx = Number(pick('USDCx')?.total_unlocked_coin || 0);
  return { cc, usdcx };
}

async function mergeHoldings(instrumentId = 'USDCx') {
  const s = await getLoopSession();
  const r = await ffetch(`${LOOP}/api/v1/.connect/pair/account/holding`, {
    headers: { Authorization: `Bearer ${s.auth_token}` },
  });
  const holdings = await r.json();
  if (!r.ok) throw new Error(`holding failed for merge: ${r.status}`);

  const item = (holdings || []).find((h) => String(h?.instrument_id?.id || '').toUpperCase() === instrumentId.toUpperCase());
  if (!item) throw new Error(`merge: instrument ${instrumentId} not found`);

  const amount = Number(item.total_unlocked_coin || 0);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`merge: no unlocked ${instrumentId}`);

  const fmtZ = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const reqAt = Date.now() - 2 * 60_000; // avoid ledger-time skew issues
  const payloadReq = {
    recipient: cfg.partyId,
    amount: amount.toFixed(10),
    instrument_admin: item?.instrument_id?.admin || 'decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef',
    instrument_id: item?.instrument_id?.id || instrumentId,
    requested_at: fmtZ(reqAt),
    execute_before: fmtZ(reqAt + 24 * 60 * 60_000),
  };

  const prep = await ffetch(`${LOOP}/api/v1/.connect/pair/transfer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.auth_token}` },
    body: JSON.stringify(payloadReq),
  });
  const prepTxt = await prep.text();
  const prepJs = prepTxt ? JSON.parse(prepTxt) : {};
  if (!prep.ok || !prepJs?.payload) throw new Error(`merge prepare failed ${prep.status} ${prepTxt.slice(0, 180)}`);

  const submit = await submitLoopCommand(prepJs.payload);
  log(`MERGE submitted instrument=${instrumentId} amount=${amount} command=${submit?.command_id || '-'}`);
  state.sidePauseUntil.buy = now() + cfg.mergePauseMs;
  return submit;
}

async function getDisclosures() {
  if (state.disclosures && now() - state.disclosuresAt < 60_000) return state.disclosures;
  const js = await templeFetch('/api/amulet/disclosures', { query: { partyId: cfg.partyId } });
  state.disclosures = js?.disclosures?.choiceContext?.disclosedContracts || [];
  state.disclosuresAt = now();
  return state.disclosures;
}

async function getTickerAndCollar() {
  const [ticker, collar, orderbook, oracleResp] = await Promise.all([
    templeFetch('/api/public/market/ticker', { query: { symbol: cfg.symbol } }),
    templeFetch('/api/public/market/order-collar'),
    templeFetch('/api/public/market/orderbook', { query: { symbol: cfg.symbol, precision: 4 } }),
    templeFetch('/api/crypto/oracle'),
  ]);

  const ob = orderbook?.orderbook || orderbook || {};
  const rawBestBid = Number(ob?.best_bid || (Array.isArray(ob?.bids) && ob.bids[0] ? (ob.bids[0].price ?? ob.bids[0][0]) : 0) || 0);
  const rawBestAsk = Number(ob?.best_ask || (Array.isArray(ob?.asks) && ob.asks[0] ? (ob.asks[0].price ?? ob.asks[0][0]) : 0) || 0);
  let bestBid = rawBestBid;
  let bestAsk = rawBestAsk;

  const market = Number(ticker?.ticker?.last_price || 0);
  if (bestBid > 0 && bestAsk > 0 && bestAsk <= bestBid) {
    // sanitize inverted book snapshot for pricing, but keep raw for housekeeping
    bestBid = round4(Math.max(0, market - cfg.tick));
    bestAsk = round4(market + cfg.tick);
  }

  return {
    market,
    oracle: Number(oracleResp?.prices?.cc || 0),
    oracleProxy: Number(ticker?.ticker?.vwap_24h || ticker?.ticker?.close_24h || ticker?.ticker?.last_price || 0),
    bestBid,
    bestAsk,
    rawBestBid,
    rawBestAsk,
    collar: Number(collar?.percentage || 0.001),
  };
}

async function getActiveOrders() {
  const js = await templeFetch('/api/trading/orders/active', { query: { symbol: cfg.symbol, limit: 50 } });
  return js.orders || [];
}

async function getDynamicMinQty() {
  if (state.dynamicMinQty != null && Date.now() - state.dynamicMinQtyAt < 5 * 60_000) return state.dynamicMinQty;
  try {
    const [a, b] = await Promise.all([
      templeFetch('/api/trading/symbol-config', { query: { symbol: cfg.symbol } }),
      templeFetch('/api/v1/market/min-order-quantity', { query: { symbol: cfg.symbol } }),
    ]);
    const q1 = Number(a?.minimum_quantity || 0);
    const q2 = Number(b?.min_order_quantity || 0);
    const q = Math.max(q1, q2, cfg.minOrderQty);
    state.dynamicMinQty = Number.isFinite(q) && q > 0 ? q : cfg.minOrderQty;
    state.dynamicMinQtyAt = Date.now();
  } catch {
    state.dynamicMinQty = cfg.minOrderQty;
    state.dynamicMinQtyAt = Date.now();
  }
  return state.dynamicMinQty;
}

async function cancelOrder(orderId) {
  return templeFetch(`/api/trading/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' });
}

function orderKey(o) {
  return `${o.order_id}|${o.side}|${o.price}|${o.original_quantity || o.quantity}`;
}

async function monitorOrders() {
  const orders = await getActiveOrders();
  const currentIds = new Set(orders.map((o) => o.order_id));

  for (const o of orders) {
    const prev = state.knownOrders.get(o.order_id);
    const orig = Number(o.original_quantity || o.quantity || 0);
    const rem = Number(o.quantity || 0);
    const filled = round4(orig - rem);

    if (!prev) {
      log(`ORDER_OPEN id=${o.order_id} side=${o.side} price=${o.price} qty=${orig}`);
    } else if (filled !== prev.filled) {
      log(`ORDER_FILL_UPDATE id=${o.order_id} filled=${filled}/${orig}`);
    }

    state.knownOrders.set(o.order_id, { filled, seenAt: now(), key: orderKey(o) });
  }

  for (const [id, prev] of [...state.knownOrders.entries()]) {
    if (!currentIds.has(id)) {
      log(`ORDER_CLOSED id=${id} lastFilled=${prev.filled}`);
      state.knownOrders.delete(id);
    }
  }

  if (state.pendingOrder && now() - state.pendingOrder.at > cfg.waitAppearMs) {
    log(`PENDING_TIMEOUT side=${state.pendingOrder.side} price=${state.pendingOrder.price} qty=${state.pendingOrder.qty} (hold gate)`);
    // keep pending gate to avoid duplicate submissions; only release on hard timeout
    if (now() - state.pendingOrder.at > cfg.pendingHardTimeoutMs) {
      log(`PENDING_HARD_TIMEOUT release gate side=${state.pendingOrder.side} price=${state.pendingOrder.price}`);
      state.pendingOrder = null;
    }
  }

  if (state.pendingOrder && orders.length > 0) {
    const hit = orders.find((o) => String(o.side).toLowerCase() === state.pendingOrder.side.toLowerCase()
      && Number(o.price) === state.pendingOrder.price
      && Number(o.original_quantity || o.quantity) === state.pendingOrder.qty);
    if (hit) {
      log(`PENDING_CONFIRMED id=${hit.order_id}`);
      state.pendingOrder = null;
    }
  }

  return orders;
}

async function waitOrderVisible(expect = null, timeoutMs = cfg.waitAppearMs) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const orders = await getActiveOrders();
    if (!expect) {
      if (orders.length > 0) return orders[0];
    } else {
      const hit = orders.find((o) => {
        if (expect.orderId && o.order_id !== expect.orderId) return false;
        if (expect.side && sideLower(o.side) !== sideLower(expect.side)) return false;
        if (expect.price != null && Number(o.price) !== Number(expect.price)) return false;
        if (expect.qty != null && Number(o.original_quantity || o.quantity) !== Number(expect.qty)) return false;
        return true;
      });
      if (hit) return hit;
    }
    await sleep(5000);
  }
  return null;
}

async function waitOrderGone(orderId, timeoutMs = cfg.waitDisappearMs) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const orders = await getActiveOrders();
    const exists = orders.some((o) => o.order_id === orderId);
    if (!exists) return true;
    await sleep(4000);
  }
  return false;
}

async function loopActiveContracts(params) {
  const s = await getLoopSession();
  const u = new URL(`${LOOP}/api/v1/.connect/pair/account/active-contracts`);
  if (params?.templateId) u.searchParams.set('templateId', params.templateId);
  if (params?.interfaceId) u.searchParams.set('interfaceId', params.interfaceId);
  const r = await ffetch(u, { headers: { Authorization: `Bearer ${s.auth_token}` } });
  if (!r.ok) throw new Error(`active-contracts failed ${r.status}`);
  return r.json();
}

async function submitLoopCommand(command) {
  const s = await getLoopSession();
  const prep = await ffetch(`${LOOP}/api/v1/.connect/tickets/prepare-transaction`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.api_key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ payload: command, ticket_id: s.ticket_id }),
  });
  const prepared = await prep.json();
  if (!prep.ok || !prepared?.transaction_hash) {
    if (prep.status === 429) {
      state.rateLimitUntil = now() + cfg.rateLimitBackoffMs;
      throw new Error(`RATE_LIMIT prepare ${prep.status}`);
    }
    throw new Error(`prepare failed ${prep.status} ${JSON.stringify(prepared).slice(0, 180)}`);
  }

  const signature = signer.signTransactionHash(prepared.transaction_hash);
  const exec = await ffetch(`${LOOP}/api/v1/.connect/tickets/execute-transaction`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.api_key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      ticket_id: s.ticket_id,
      request_id: crypto.randomUUID(),
      command_id: prepared.command_id,
      transaction_data: prepared.transaction_data,
      signature,
    }),
  });
  const js = await exec.json();
  if (!exec.ok) {
    if (exec.status === 429) {
      state.rateLimitUntil = now() + cfg.rateLimitBackoffMs;
      throw new Error(`RATE_LIMIT execute ${exec.status}`);
    }
    throw new Error(`execute failed ${exec.status} ${JSON.stringify(js).slice(0, 180)}`);
  }
  return js;
}

function decideSide(market, oracle, bestBid = 0, bestAsk = 0) {
  if (cfg.forceSide === 'sell') return 'Sell';
  if (cfg.forceSide === 'buy') return 'Buy';
  if (market > oracle) return 'Sell';
  if (market < oracle) return 'Buy';

  // market == oracle: choose any side that can be top-of-book
  const sellCandidate = round4(Math.min(oracle - cfg.tick, (bestAsk > 0 ? bestAsk : oracle) - cfg.tick));
  const buyCandidate = round4(oracle + 2 * cfg.tick);
  const topSell = bestAsk > 0 ? round4(bestAsk - cfg.tick) : null;
  const topBuy = bestBid > 0 ? round4(bestBid + cfg.tick) : null;

  if (topSell != null && sellCandidate <= topSell) return 'Sell';
  if (topBuy != null && buyCandidate >= topBuy) return 'Buy';
  return null;
}

function targetPrice(side, market, oracle, bestBid = 0, bestAsk = 0) {
  if (side === 'Sell') {
    // Always be cheapest ask while still tracking oracle move
    const byOracle = round4(oracle - 1 * cfg.tick);
    const byBook = round4((bestAsk > 0 ? bestAsk : market) - cfg.tick);
    return round4(Math.min(byOracle, byBook));
  }

  // Buy remains oracle-capped as agreed
  return round4(oracle + 2 * cfg.tick);
}

function isStale(order, side, target) {
  const price = Number(order.price);
  const drift = Math.abs(price - target) / cfg.tick;
  if (drift >= cfg.replaceIfDriftTicks) return true;
  const born = new Date(order.created_at || order.updated_at || Date.now()).getTime();
  if (now() - born > cfg.maxOrderAgeMs) return true;
  return false;
}

async function buildProposal(side, price, quantity) {
  initializeConfig({
    NETWORK: cfg.network,
    VALIDATOR_API_URL: process.env.VALIDATOR_API_URL || 'https://api.templedigitalgroup.com',
    VALIDATOR_SCAN_API_URL: process.env.VALIDATOR_SCAN_API_URL || 'https://api.templedigitalgroup.com',
    VALIDATOR_USER_PARTY_ID: cfg.partyId,
  });

  const disclosures = await getDisclosures();
  const provider = { getActiveContracts: loopActiveContracts };
  const expiration = new Date(now() + 12 * 60 * 60_000).toISOString();
  const userId = String(state.templeLoginPayload?.user?.user_id || '');

  const proposal = await createOrderProposal({
    party: cfg.partyId,
    symbol: cfg.symbol,
    side,
    quantity: String(quantity),
    pricePerUnit: String(price),
    expiration,
    orderType: 'limit',
    userId,
  }, true, provider, disclosures);

  if (proposal?.error) throw new Error(`proposal error: ${proposal.error}`);
  if (!proposal?.command) throw new Error('proposal missing command');
  return proposal.command;
}

async function placeLimit(side, price, quantity) {
  if (cfg.dryRun) {
    log(`[DRY_RUN] place ${side} ${quantity} @ ${price}`);
    return { dryRun: true };
  }
  const command = await buildProposal(side, price, quantity);
  const sub = await submitLoopCommand(command);
  log(`[LIVE] submitted ${side} ${quantity} @ ${price} command=${sub?.command_id || '-'} submission=${sub?.submission_id || '-'}`);
  return sub;
}

async function evaluateAndAct(market, oracle, bestBid, bestAsk, knownOrders = null) {
  const signalSide = decideSide(market, oracle, bestBid, bestAsk);
  if (!signalSide) return log('SIGNAL none (market == oracle), skip');

  if (state.pendingOrder) {
    return log(`GATE pending order in-flight side=${state.pendingOrder.side} price=${state.pendingOrder.price} qty=${state.pendingOrder.qty}`);
  }

  if (inRateLimitBackoff()) {
    return log(`GATE rate-limit backoff until=${new Date(state.rateLimitUntil).toISOString()}`);
  }

  const sellPrice = targetPrice('Sell', market, oracle, bestBid, bestAsk);
  const buyPrice = targetPrice('Buy', market, oracle, bestBid, bestAsk);
  const balances = await getBalances();

  const minQty = await getDynamicMinQty();

  const sellableCc = Math.max(0, balances.cc - cfg.ccFixedReserve);
  const sellQtyDyn = round4(sellableCc * cfg.sellBalancePct);
  const canSell = sellPrice != null && sellQtyDyn >= minQty;

  const buyQtyByBalance = buyPrice && buyPrice > 0 ? (balances.usdcx / buyPrice) : 0;
  const buyQty = round4(buyQtyByBalance * cfg.buyBalancePct); // partial allocation per order
  const canBuy = buyPrice != null && buyQty >= minQty;

  let side = signalSide;
  if (side === 'Sell' && !canSell && canBuy) side = 'Buy';
  if (side === 'Buy' && !canBuy && canSell) side = 'Sell';

  log(`SIGNAL=${signalSide} RESOLVED=${side} market=${market} oracle=${oracle} bid=${bestBid} ask=${bestAsk} sellPrice=${sellPrice ?? 'WAIT'} buyPrice=${buyPrice ?? 'WAIT'}`);
  log(`BALANCE cc=${balances.cc.toFixed(4)} usdcx=${balances.usdcx.toFixed(4)} sellableCc=${sellableCc.toFixed(4)} sellQty=${sellQtyDyn.toFixed(4)} canSell=${canSell} canBuy=${canBuy} buyQty=${buyQty.toFixed(4)} minQty=${minQty}`);

  if (sidePaused(side)) {
    return log(`GATE side ${side} paused until=${new Date(state.sidePauseUntil[sideLower(side)]).toISOString()}`);
  }

  if (side === 'Sell' && !canSell) {
    return log(`SKIP SELL: sellQty ${sellQtyDyn.toFixed(4)} < min ${minQty} (CC=${balances.cc.toFixed(4)} reserve=${cfg.ccFixedReserve})`);
  }
  if (side === 'Buy' && !canBuy) {
    return log(`SKIP BUY: qty ${buyQty.toFixed(4)} < min ${minQty} (USDCx=${balances.usdcx.toFixed(4)}, price=${buyPrice})`);
  }

  if (now() - state.lastActionAt < cfg.cooldownMs) {
    return log('SKIP cooldown active');
  }

  const target = side === 'Sell' ? sellPrice : buyPrice;

  // HARD ORDERBOOK GATE: never place if we are visibly not top-of-book at decision time.
  const topBuy = bestBid > 0 ? round4(bestBid + cfg.tick) : null;
  const topSell = bestAsk > 0 ? round4(bestAsk - cfg.tick) : null;
  if (side === 'Buy' && topBuy != null && target < topBuy) {
    return log(`WAIT BUY: target ${target} < topBid ${topBuy} (orderbook gate)`);
  }
  if (side === 'Sell' && topSell != null && target > topSell) {
    return log(`WAIT SELL: target ${target} > topAsk ${topSell} (orderbook gate)`);
  }

  const targetQty = side === 'Sell' ? sellQtyDyn : buyQty;

  const all = knownOrders || await monitorOrders();
  const sameSide = all.filter((o) => String(o.side || '').toLowerCase() === side.toLowerCase());

  const exact = sameSide.find((o) => Number(o.price) === target);
  if (exact) {
    return log(`KEEP ${side} order @ ${target}`);
  }

  // SELL policy requested:
  // - if oracle rises (new target higher), keep older lower sell (do not cancel)
  // - if oracle drops (new target lower), place new lower sell then cancel higher old sells
  if (side === 'Sell' && sameSide.length > 0) {
    const prices = sameSide.map((o) => Number(o.price)).filter((n) => Number.isFinite(n));
    const lowestExisting = Math.min(...prices);
    if (target >= lowestExisting) {
      return log(`HOLD SELL existing lower price ${lowestExisting} (new target=${target})`);
    }
  }

  // Prefer placing a new quote first; cancel old quotes later by rule.
  if (cfg.maxOrdersPerSide > 0 && sameSide.length >= cfg.maxOrdersPerSide) {
    // Special case: allow one-step improve for SELL (lower target), then clean higher old orders.
    if (!(side === 'Sell' && sameSide.length > 0 && target < Math.min(...sameSide.map((o) => Number(o.price)).filter((n) => Number.isFinite(n))))) {
      return log(`HOLD ${side}: maxOrdersPerSide=${cfg.maxOrdersPerSide} reached, skip new place`);
    }
  }

  if (sameSide.length > 0) {
    const cur = sameSide[0];
    const curPrice = Number(cur.price);
    const gapTicks = Math.abs(target - curPrice) / cfg.tick;
    if (gapTicks < cfg.repriceGapTicks) {
      return log(`HOLD ${side} existing @ ${curPrice} (gapTicks=${gapTicks.toFixed(1)})`);
    }
    log(`PLACE_NEW ${side} first target=${target} existing=${curPrice}`);
  }

  try {
    await placeLimit(side, target, targetQty);
    state.lastActionAt = now();

    if (!cfg.dryRun) {
      // non-blocking: set pending and let monitor loop confirm visibility
      state.pendingOrder = { side, price: target, qty: targetQty, at: now() };
      log('ORDER submitted; visibility will be checked asynchronously by monitor loop');

      // For SELL improvement: after placing lower sell, cancel older higher sell orders
      if (side === 'Sell' && sameSide.length > 0) {
        for (const o of sameSide) {
          const p = Number(o.price || 0);
          if (p > target) {
            log(`CLEANUP cancel older higher SELL id=${o.order_id} price=${p} new=${target}`);
            await cancelOrder(o.order_id);
          }
        }
      }
    }
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('RATE_LIMIT')) {
      log(`BACKOFF rate-limit applied for ${Math.round(cfg.rateLimitBackoffMs / 1000)}s`);
      return;
    }
    if (msg.toLowerCase().includes('needs to merge his holdings')) {
      log('MERGE required by validator, trying self-transfer merge for USDCx...');
      try {
        await mergeHoldings('USDCx');
      } catch (merr) {
        log(`MERGE failed: ${merr.message}`);
        state.sidePauseUntil.buy = now() + cfg.mergePauseMs;
      }
      return;
    }
    throw e;
  }
}


function startOracleWs() {
  const ws = new WebSocket('wss://ws.templedigitalgroup.com/v1/stream', {
    headers: { Origin: 'https://app.templedigitalgroup.com' },
  });

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['oracle:amulet'] }));
  });

  ws.on('message', (buf) => {
    try {
      const m = JSON.parse(String(buf));
      if (m?.channel?.startsWith('oracle:')) {
        const p = Number(m?.data?.price);
        if (Number.isFinite(p) && p > 0) state.wsOracle = p;
      }
    } catch {}
  });

  ws.on('close', () => setTimeout(startOracleWs, 4000));
  ws.on('error', () => {});
}

async function cycle() {
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    const [mkt, orders] = await Promise.all([
      getTickerAndCollar(),
      monitorOrders(),
    ]);

    const market = mkt.market;
    const oracle = state.wsOracle ?? mkt.oracle ?? mkt.oracleProxy;
    const bestBid = mkt.bestBid || 0;
    const bestAsk = mkt.bestAsk || 0;
    const hbBid = mkt.rawBestBid || bestBid;
    const hbAsk = mkt.rawBestAsk || bestAsk;

    // housekeeping is conservative: do not auto-cancel just because not top.
    // cancellation is handled by strategy branch (e.g. when placing improved price).

    const marketChanged = state.lastMarket == null || market !== state.lastMarket;
    const bookChanged = state.lastBid == null || state.lastAsk == null || bestBid !== state.lastBid || bestAsk !== state.lastAsk;
    const oracleChanged = state.lastOracle == null || oracle !== state.lastOracle;
    const triggerChanged = bookChanged || marketChanged || oracleChanged;
    const heartbeatDue = now() - state.lastHeartbeatAt >= cfg.heartbeatMs;

    if (triggerChanged) {
      log(`TRIGGER market:${state.lastMarket ?? '-'}->${market} oracle:${state.lastOracle ?? '-'}->${oracle} bid:${state.lastBid ?? '-'}->${bestBid} ask:${state.lastAsk ?? '-'}->${bestAsk}`);
      state.lastMarket = market;
      state.lastOracle = oracle;
      state.lastBid = bestBid;
      state.lastAsk = bestAsk;
      await evaluateAndAct(market, oracle, bestBid, bestAsk, orders);
    } else if (heartbeatDue) {
      state.lastHeartbeatAt = now();
      log(`HEARTBEAT market=${market} oracle=${oracle} bid=${bestBid} ask=${bestAsk} activeOrders=${orders.length} pending=${state.pendingOrder ? 'yes' : 'no'}`);
      // keep bot from getting "stuck" even without tick changes
      await evaluateAndAct(market, oracle, bestBid, bestAsk, orders);
    }
  } catch (e) {
    console.error(`[${ts()}] cycle error:`, e.message);
  } finally {
    state.inFlight = false;
  }
}

async function main() {
  log(`Start loop-bot symbol=${cfg.symbol} dryRun=${cfg.dryRun} pollMs=${cfg.pollMs} heartbeatMs=${cfg.heartbeatMs}`);
  startOracleWs();
  await cycle();
  if (cfg.runOnce) return;
  setInterval(() => cycle(), cfg.pollMs);
  setInterval(() => monitorOrders().catch((e) => console.error(`[${ts()}] monitor error:`, e.message)), cfg.monitorMs);
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
