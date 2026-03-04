import 'dotenv/config';
import {
  initializeConfig,
  createOrderProposal,
  getOrdersForParty,
  getOrderProposalsForParty,
  getUserBalances,
} from '@temple-digital-group/temple-canton-js';

function must(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env: ${name}`);
  return String(v).trim();
}

function num(name, fallback = undefined) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number env ${name}=${raw}`);
  return n;
}

async function loadWalletProvider() {
  const modPath = process.env.WALLET_PROVIDER_MODULE?.trim();
  if (!modPath) return null;
  const mod = await import(modPath);
  const provider = mod.default ?? mod.provider ?? null;
  if (!provider || typeof provider.signAndSubmit !== 'function') {
    throw new Error(`Invalid wallet provider module: ${modPath}. Need default export with signAndSubmit(command).`);
  }
  return provider;
}

function buildConfig() {
  const cfg = {
    NETWORK: must('NETWORK'),
  };

  if (process.env.VALIDATOR_API_URL) cfg.VALIDATOR_API_URL = process.env.VALIDATOR_API_URL;
  if (process.env.VALIDATOR_SCAN_API_URL) cfg.VALIDATOR_SCAN_API_URL = process.env.VALIDATOR_SCAN_API_URL;
  if (process.env.VALIDATOR_USER_PARTY_ID) cfg.VALIDATOR_USER_PARTY_ID = process.env.VALIDATOR_USER_PARTY_ID;
  if (process.env.JWT_TOKEN) cfg.JWT_TOKEN = process.env.JWT_TOKEN;

  return cfg;
}

async function main() {
  const party = must('PARTY_ID');
  const symbol = must('SYMBOL');
  const side = must('SIDE');
  const quantity = String(must('QUANTITY'));
  const pricePerUnit = String(must('LIMIT_PRICE'));
  const expiryMinutes = num('EXPIRY_MINUTES', 15);
  const dryRun = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';
  const maxNotional = num('MAX_NOTIONAL_USDX', 10);

  const sideNorm = side.toLowerCase();
  if (!['buy', 'sell'].includes(sideNorm)) throw new Error('SIDE must be Buy or Sell');

  const notional = Number(quantity) * Number(pricePerUnit);
  if (!Number.isFinite(notional) || notional <= 0) throw new Error(`Invalid notional: ${quantity} x ${pricePerUnit}`);
  if (notional > maxNotional) throw new Error(`Risk guard blocked: notional ${notional} > MAX_NOTIONAL_USDX ${maxNotional}`);

  initializeConfig(buildConfig());

  console.log('[1/5] Fetch balances...');
  const balances = await getUserBalances(party);
  console.log(JSON.stringify(balances, null, 2));

  console.log('[2/5] Pre-check existing orders/proposals...');
  const [orders, proposals] = await Promise.all([
    getOrdersForParty(party),
    getOrderProposalsForParty(party),
  ]);
  console.log(`open orders: ${Array.isArray(orders) ? orders.length : 'n/a'}`);
  console.log(`open proposals: ${Array.isArray(proposals) ? proposals.length : 'n/a'}`);

  const expiration = new Date(Date.now() + expiryMinutes * 60_000).toISOString();
  const orderArgs = {
    party,
    symbol,
    side: sideNorm === 'buy' ? 'Buy' : 'Sell',
    quantity,
    pricePerUnit,
    expiration,
    orderType: 'limit',
  };

  const walletProvider = await loadWalletProvider();
  const useWalletFlow = Boolean(walletProvider);

  console.log(`[3/5] Build order proposal (${useWalletFlow ? 'wallet-provider' : 'validator'})...`);
  const proposalResult = useWalletFlow
    ? await createOrderProposal(orderArgs, true, walletProvider)
    : await createOrderProposal(orderArgs);

  if (dryRun) {
    console.log('[DRY_RUN] Proposal created, skipping submission.');
    console.log(JSON.stringify(proposalResult, null, 2));
    return;
  }

  if (useWalletFlow) {
    console.log('[4/5] Submit command via wallet provider...');
    const submitRes = await walletProvider.signAndSubmit(proposalResult);
    console.log(JSON.stringify(submitRes, null, 2));
  } else {
    console.log('[4/5] Order placed via validator mode.');
    console.log(JSON.stringify(proposalResult, null, 2));
  }

  console.log('[5/5] Post-check orders...');
  const latestOrders = await getOrdersForParty(party);
  console.log(JSON.stringify(latestOrders, null, 2));
}

main().catch((err) => {
  console.error('FAILED:', err?.message || err);
  process.exit(1);
});
