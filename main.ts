// Pump.fun Paper Sprint: a traction-breakout rider (agent-fun/replay/v2).
//
// The dev window teaches three things, and the bot is built around them:
//
// - Launches mostly bleed. The kit's pilot momentum bot scores -9.45 SOL
//   and its reversion bot -4.37 SOL on the dev window, and every launch
//   buying variant measured here loses at least the round-trip fee floor
//   (about 1.25% of the stake in curve fees each way, plus 105k lamports
//   per order). Short-window momentum, dip buying and holding launches all
//   lose; that is the market, not a tuning problem.
// - The payoff that matters is completion. 35 of the 1,222 coins in the
//   dev window completed (migrated off the curve) at about 14.7x their
//   create price, but 27 of them completed in the very slot they were
//   created, so they can never be bought. The 7 buyable completers paid
//   5.7x to 12.3x from an early entry. A rider that only boards curves
//   with real traction and then simply stays on has a shot at one.
// - Single-slot coordinated dumps are the killer: a coin can lose 80% or
//   more inside one slot when a cluster unloads, and an order decided on
//   that slot's batch fills two slots later, after the crash. No stop can
//   outrun that. The defence is short exposure and small stakes, so the
//   rider holds at most 600 slots and never puts more than 0.26 SOL into
//   one coin.
//
// The rider boards a curve once, when it first holds at least 10 SOL of
// real reserves with at least 20 distinct non-creator buyers, its price
// at least 10% above its create price, and its creator not selling. It
// buys 0.85% of the real reserve (the per-reply size cap is 1%, the
// headroom keeps the buy inside it) with 1.5% buy slippage, and adds
// once more, another 0.85% of reserve, when the curve
// crosses 20 SOL of real reserves. It leaves on a 15% take-profit, a
// 15% stop, a trailing stop that arms at +30% and exits on a 15% fall
// from the peak, a creator sell, or 600 slots held. A curve that
// completes is closed by the replay at its final reserves, which is
// where the rider's payoff lives.
//
// Breadth is a guardrail sleeve, not the strategy: the house needs a
// round trip of at least 0.01 SOL on each of at least 20 coins, and the
// rider alone may not reach that on a 6-hour final window. So while
// fewer than 20 coins are covered, the bot also runs tiny 0.01 SOL probe
// round trips on liquid young curves, at most one probe open at a time,
// sold as soon as the buy lands. A probe costs about 0.0005 SOL in fees,
// so twenty of them cost about 0.01 SOL: cheap insurance.
//
// Fees are about 1.25% of value each way on the curve plus 105k lamports
// per order, so a round trip costs roughly 3% of the stake; the rider's
// most is 0.26 SOL a coin, so even five positions going to zero is only
// about 15% of the 10 SOL capital, far inside the 50% drawdown bar.
//
// Deterministic by construction: no clock, no environment, no
// randomness; iteration only over insertion-ordered maps fed by the
// batch stream. The hello message carries the run seed, caps and fees;
// each batch carries the slot's events, marks and fills; orders are the
// replies the shim sends.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE_BPS = 125n; // protocol 95 bps + creator 30 bps, charged on the curve each way.
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL, the guardrail floor.

// --- rider entry: board a curve only once it shows real traction -----------
const RIDER_MIN_REAL_SOL = 10; // real SOL reserve the curve must first hold
const RIDER_MIN_BUYERS = 20; // distinct non-creator buyers seen before entry
const RIDER_MIN_RUNUP = 1.1; // price now over the create price, at least
const RIDER_BUY_BPS = 85; // buy 0.85% of the real reserve: the per-reply cap is
// 1%, but the harness measures it against reserves at a slightly
// different moment than the bot sees, so a buy sized exactly at the
// cap is rejected whenever the reserve rose inside the batch (330 of
// them on the dev window). 85 bps leaves headroom and still fills.
// Buy slippage is 1.5%: with 2 slots of latency, a coin that already
// jumped more than 1.5% past the decision price is a chase, not an entry;
// the fill is refused and the coin is retried on a later batch. Tighter
// slippage scored best with the 15% exits on the dev window; wide open
// slippage scored worse.
const RIDER_BUY_SLIPPAGE_BPS = 150;
const RIDER_ADD_REAL_SOL = 20; // add once when real reserves cross this
const RIDER_ADD_BPS = 85; // add 0.85% of the real reserve, same headroom as the first buy
// --- rider exits -------------------------------------------------------------
// Symmetric +15% / -15% with a 600-slot hold scored best on the dev window
// (sim mean +1.27 SOL over four failed-tx draws, worst draw +1.25, and
// +1.10 even without the single best round trip; the +25% / -25% / 300-slot
// settings the rider shipped with scored +0.13 on the same sim). Tighter
// exits win because a traction coin that does not pay within a few minutes
// usually gives it back: taking 15% early beats waiting for 25% while the
// single-slot dumps eat the position, and a 15% stop cuts losers before
// they become 25% ones. The trailing stop below arms at +30%, so with a
// 15% take-profit it never fires first; it stays as a guard for the case
// a take-profit fill is refused.
const RIDER_TAKE_PROFIT = 15; // sell when liquidation value is 15% over cost
const RIDER_STOP_LOSS = 15; // sell when it is 15% under cost
const RIDER_TRAIL_ARM = 30; // trailing stop arms at +30% over cost
const RIDER_TRAIL_DROP = 15; // ...then exits on a 15% fall from the peak value
const RIDER_MAX_HOLD = 600; // slots; sell after holding this long
// --- probe fallback: guardrail insurance, deliberately tiny ------------------
const PROBE_STAKE_SOL = 0.01;
const PROBE_MIN_REAL_SOL = 1.5; // real SOL a curve needs for a 0.01 SOL probe
const PROBE_TARGET_COINS = 20; // distinct coins the house wants round-tripped
const PROBE_MAX_OPEN = 1; // most probe positions open at once

interface Coin {
  created: number | null;
  creator: Pubkey;
  createPrice: number; // virtual quote over virtual token at create
  buyers: Set<Pubkey>;
  devSold: boolean;
  entered: boolean; // a rider buy was decided, or the curve completed
}

interface Held {
  opened: number;
  peak: bigint; // best liquidation value seen, in lamports
  added: boolean; // the add-on buy was decided
  probe: boolean; // a guardrail probe, not a rider
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
/** What the pending buy on a mint is for, so a rejected fill can reopen it. */
const buyIntent = new Map<Pubkey, 'rider' | 'add' | 'probe'>();
/** Lamports of filled buys per mint, and mints with a filled sell leg. */
const boughtLamports = new Map<Pubkey, bigint>();
const soldCoins = new Set<Pubkey>();

const coinOf = (mint: Pubkey): Coin => {
  let c = coins.get(mint);
  if (c === undefined) {
    c = { created: null, creator: '', createPrice: 0, buyers: new Set(), devSold: false, entered: false };
    coins.set(mint, c);
  }
  return c;
};

/** What selling `tokens` against (vq, vt) would pay after curve fees, less one tx fee. */
function liquidationValue(tokens: bigint, vq: bigint, vt: bigint, tx: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  const fee = (gross * CURVE_FEE_BPS + 9999n) / 10000n;
  const net = gross - fee - tx;
  return net > 0n ? net : 0n;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const now = batch.slot;
  const touched = new Set<Pubkey>();

  // Read this slot's tape: who created what, who bought, whether the creator sold.
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const c = coinOf(e.mint);
      c.created = e.slot;
      c.creator = e.creator;
      c.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      touched.add(e.mint);
    } else if (e.event === 'TradeEvent') {
      const c = coinOf(e.mint);
      if (e.is_buy) {
        if (e.user !== c.creator) c.buyers.add(e.user);
      } else if (e.user === c.creator) {
        c.devSold = true;
      }
      touched.add(e.mint);
    } else if (e.event === 'CompleteEvent') {
      const c = coins.get(e.mint);
      if (c !== undefined) c.entered = true; // never buy a completed curve
    }
  }

  // Fold fills in: count covered coins, and reopen a coin whose buy was refused.
  for (const f of batch.fills) {
    if (f.status === 'filled') {
      if (f.side === 'buy') {
        boughtLamports.set(f.mint, (boughtLamports.get(f.mint) ?? 0n) + BigInt(f.quote_lamports));
      } else {
        soldCoins.add(f.mint);
      }
    }
    if (f.side === 'buy' && f.status !== 'filled') {
      const intent = buyIntent.get(f.mint);
      if (intent === 'rider') {
        const c = coins.get(f.mint);
        if (c !== undefined) c.entered = false;
        held.delete(f.mint);
      } else if (intent === 'add') {
        const h = held.get(f.mint);
        if (h !== undefined) h.added = false;
      } else if (intent === 'probe') {
        held.delete(f.mint);
      }
    }
    if (f.side === 'buy') buyIntent.delete(f.mint);
  }
  let covered = 0;
  for (const [mint, lamports] of boughtLamports) {
    if (lamports >= MIN_BUY_LAMPORTS && soldCoins.has(mint)) covered++;
  }

  const orders: OrderInput[] = [];
  const cap = state.hello.caps.max_orders_per_batch;
  const tx = state.txFeeLamports();
  const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
  const pendingMints = new Set<Pubkey>();
  for (const o of state.pending.values()) pendingMints.add(o.order.mint);

  // Exits first, riders and probes alike.
  for (const [mint, h] of held) {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (pos === undefined) {
      if (!pendingMints.has(mint)) held.delete(mint);
      continue;
    }
    if (curve === undefined || curve.complete) continue;
    if (pendingMints.has(mint)) continue;
    const mk = marks.get(mint);
    const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
    const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
    const value = liquidationValue(pos.token_amount, vq, vt, tx);
    if (value > h.peak) h.peak = value;
    const cost = pos.cost_lamports;
    let exit = false;
    if (h.probe) {
      // A probe sells as soon as its buy has landed: the round trip is the point.
      exit = true;
    } else {
      if (value * 100n >= cost * BigInt(100 + RIDER_TAKE_PROFIT)) exit = true; // +15%
      else if (value * 100n <= cost * BigInt(100 - RIDER_STOP_LOSS)) exit = true; // -15%
      else if (h.peak * 100n >= cost * BigInt(100 + RIDER_TRAIL_ARM) && value * 100n <= h.peak * BigInt(100 - RIDER_TRAIL_DROP)) exit = true;
      else if (now - h.opened >= RIDER_MAX_HOLD) exit = true;
      else {
        const c = coins.get(mint);
        if (c !== undefined && c.devSold) exit = true; // creator sold while held
      }
    }
    if (!exit) continue;
    if (orders.length >= cap) break;
    orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
  }

  // Add-ons: one more 0.85% of reserve when a held rider crosses 20 SOL real.
  // An add tops up a position that already exists, so it does not need a
  // free position slot; only the per-reply order cap and free cash bind it.
  let free = state.freeCashLamports();
  let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
  for (const [mint, h] of held) {
    if (orders.length >= cap) break;
    if (h.probe || h.added) continue;
    if (!state.positions.has(mint) || pendingMints.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
    if (rqSol < RIDER_ADD_REAL_SOL) continue;
    let amount = (curve.real_quote_reserves * BigInt(RIDER_ADD_BPS)) / 10000n;
    const capLamports = state.maxBuyLamports(mint);
    if (amount > capLamports) amount = capLamports;
    if (amount < MIN_BUY_LAMPORTS || free < amount + tx) continue;
    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: RIDER_BUY_SLIPPAGE_BPS });
    free -= amount + tx;
    buyIntent.set(mint, 'add');
    h.added = true;
  }

  // Rider entries: board a touched curve that just showed real traction.
  let probesOpen = 0;
  for (const h of held.values()) if (h.probe) probesOpen++;
  for (const mint of touched) {
    if (orders.length >= cap || slotsLeft <= 0) break;
    if (state.positions.has(mint) || pendingMints.has(mint) || held.has(mint)) continue;
    const c = coins.get(mint)!;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete || c.entered || c.created === null) continue;
    if (c.devSold || c.buyers.size < RIDER_MIN_BUYERS || c.createPrice <= 0) continue;
    const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
    if (rqSol < RIDER_MIN_REAL_SOL) continue;
    const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
    if (price < c.createPrice * RIDER_MIN_RUNUP) continue;
    let amount = (curve.real_quote_reserves * BigInt(RIDER_BUY_BPS)) / 10000n;
    const capLamports = state.maxBuyLamports(mint);
    if (amount > capLamports) amount = capLamports;
    if (amount < MIN_BUY_LAMPORTS || free < amount + tx) continue;
    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: RIDER_BUY_SLIPPAGE_BPS });
    free -= amount + tx;
    slotsLeft--;
    buyIntent.set(mint, 'rider');
    c.entered = true;
    held.set(mint, { opened: now, peak: 0n, added: false, probe: false });
  }

  // Probe fallback: tiny round trips on liquid curves until 20 coins are covered.
  if (covered < PROBE_TARGET_COINS && probesOpen < PROBE_MAX_OPEN) {
    for (const mint of touched) {
      if (orders.length >= cap || slotsLeft <= 0) break;
      if (state.positions.has(mint) || pendingMints.has(mint) || held.has(mint)) continue;
      const c = coins.get(mint);
      if (c === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (boughtLamports.has(mint)) continue; // already round-tripped or probed
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (rqSol < PROBE_MIN_REAL_SOL) continue;
      const amount = BigInt(Math.floor(PROBE_STAKE_SOL * LAMPORTS));
      const capLamports = state.maxBuyLamports(mint);
      if (amount > capLamports || amount < MIN_BUY_LAMPORTS || free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: RIDER_BUY_SLIPPAGE_BPS });
      free -= amount + tx;
      slotsLeft--;
      buyIntent.set(mint, 'probe');
      held.set(mint, { opened: now, peak: 0n, added: false, probe: true });
      probesOpen++;
      break; // one probe per batch: it sells next batch, then the next may start
    }
  }
  return orders;
}

await runBot({ onBatch });
