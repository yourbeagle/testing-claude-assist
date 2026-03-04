# temple-loop-trader

Small-size live template for Temple trading with optional wallet-provider flow (Loop-compatible adapter).

## Quick start

```bash
cd temple-loop-trader
cp .env.example .env
# fill your real credentials in .env
npm install
npm run start
```

## Minimum env

- `NETWORK=mainnet`
- `PARTY_ID=<your canton party id>`
- `SYMBOL=Amulet/USDCx`
- `SIDE=Buy` or `Sell`
- `QUANTITY`, `LIMIT_PRICE`

## Realtime loop bot (tick-driven)

Run:

```bash
cd temple-loop-trader
DOTENV_CONFIG_PATH=.env.example npm run bot
```

Important env knobs:

- `SELL_QTY=40`
- `CC_RESERVE=10`
- `BUY_CAP_CC=36`
- `MIN_ORDER_QTY=35`
- `TICK_SIZE=0.0001`
- `REPLACE_COOLDOWN_MS=15000`
- `DRY_RUN=true|false`
- `RUN_ONCE=true` for single-cycle test

Bot logic:
- on each tick change, decide side using `market vs oracle`
- SELL target = `max(market-1tick, oracle-1tick)`
- BUY target = `min(market+1tick, oracle+2tick)`
- avoids spam with cooldown + no-op if existing order already at target

## Wallet-provider mode (Loop style)

Set `WALLET_PROVIDER_MODULE` to a local JS module that default-exports:

```js
export default {
  async signAndSubmit(command) {
    // sign command with Loop wallet + submit
    return { txHash: '...' };
  }
}
```

When this is set, script will call `createOrderProposal(..., true, walletProvider)` and submit through `signAndSubmit`.

## Validator mode

If you have validator+JWT access, fill:

- `VALIDATOR_API_URL`
- `VALIDATOR_SCAN_API_URL`
- `VALIDATOR_USER_PARTY_ID`
- `JWT_TOKEN`

Then order can be sent without wallet provider adapter.

## Safety defaults

- `MAX_NOTIONAL_USDX=10` blocks oversized initial orders
- `DRY_RUN=true` to test flow without submission
