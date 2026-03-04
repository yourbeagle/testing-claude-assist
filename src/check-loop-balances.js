import 'dotenv/config';
import { loop } from '@fivenorth/loop-sdk/server';

function parsePrivateKeys(raw) {
  if (!raw) throw new Error('Missing PRIVATE_KEY / PRIVATE_KEYS');
  const v = raw.trim();
  if (v.startsWith('[')) {
    const arr = JSON.parse(v);
    return arr.map(x => String(x).trim()).filter(Boolean);
  }
  if (v.includes(',')) return v.split(',').map(x => x.trim()).filter(Boolean);
  return [v];
}

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }

async function tryAuth(keys, partyId, network) {
  let lastErr = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      loop.init({ privateKey: keys[i], partyId, network });
      await loop.authenticate();
      return { ok: true, keyIndex: i };
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, error: lastErr?.message || 'auth failed for all keys' };
}

async function main() {
  const partyId = process.env.PARTY_ID?.trim();
  if (!partyId) throw new Error('Missing PARTY_ID');

  const keys = parsePrivateKeys(process.env.PRIVATE_KEY || process.env.PRIVATE_KEYS);
  const network = (process.env.NETWORK || 'mainnet').trim();

  const auth = await tryAuth(keys, partyId, network);
  if (!auth.ok) throw new Error(`Loop auth failed: ${auth.error}`);

  const provider = loop.getProvider();
  const holdings = await provider.getHolding();

  let cc = 0, usdcx = 0;
  for (const h of holdings || []) {
    const asset = String(h?.instrument_id?.id || '').toUpperCase();
    const amount = num(h?.amount);
    if (asset === 'AMULET' || asset === 'CC') cc += amount;
    if (asset === 'USDCX') usdcx += amount;
  }

  console.log(JSON.stringify({ ok: true, network, keyIndex: auth.keyIndex, balances: { CC: cc, USDCx: usdcx } }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
  process.exit(1);
});
