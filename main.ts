// Pump.fun Paper Sprint: a traction rider (agent-fun/replay/v2).
//
// The idea is deliberately narrow: most new curves bleed, and the only
// reliable payoff on this market is a curve that keeps climbing after it
// has already shown real demand. So the bot waits for proof, then rides
// the move with a small stake and gets out fast either way.
//
// What counts as proof: the curve holds at least 10 SOL of real reserves,
// at least 20 wallets other than the creator have bought it, its price is
// at least 10% above where it was created, and the creator has not sold.
// A curve that completes is never bought. Once in, the bot adds a second
// small tranche if real reserves cross 20 SOL, and it leaves on a 15%
// take-profit, a 15% stop, a trailing stop that arms at +30% and exits on
// a 15% fall from the peak, a creator sale while held, or 600 slots held.
//
// The stake is 0.85% of the curve's real reserves per buy. The per-reply
// size cap is 1%, so 0.85% leaves headroom: a buy sized exactly at the cap
// is refused whenever reserves rose inside the batch. Buys use 1.5%
// slippage, because with two slots of latency a coin that jumped further
// than that past the decision price is a chase, not an entry. Sells use
// wide-open slippage: the point of an exit is to be out.
//
// The house needs a round trip of at least 0.01 SOL on each of at least
// 20 coins, and the rider alone may not reach that on a six-hour final
// window. So while fewer than 20 coins are covered, the bot also runs
// tiny 0.01 SOL probe round trips on liquid young curves, at most one
// probe open at a time, sold as soon as the buy lands. A probe costs
// about 0.0005 SOL in fees, so twenty of them cost about 0.01 SOL.
//
// Fees are about 1.25% of value each way on the curve plus 105k lamports
// per order, so a round trip costs roughly 3% of the stake. The rider's
// worst case is five positions going to zero, which is far inside the
// 50% drawdown bar on 10 SOL of capital.
//
// Deterministic by construction: no clock, no environment, no randomness.
// The only state is insertion-ordered maps fed by the batch stream, and
// the only inputs are the hello message (seed, caps, fees) and the
// batches the harness sends.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const FEE_BPS = 125n; // protocol 95 bps + creator 30 bps, charged on the curve each way.
const MIN_BUY = LAMPORTS_PER_SOL / 100n; // 0.01 SOL, the guardrail floor for a round trip.

// --- what counts as traction -------------------------------------------------
const NEED_REAL_SOL = 10; // real SOL the curve must first hold
const NEED_BUYERS = 20; // distinct non-creator buyers seen before entry
const NEED_RUNUP = 1.1; // price now over the create price, at least
const BUY_BPS = 85; // buy 0.85% of real reserves; the per-reply cap is 1%
const BUY_SLIPPAGE_BPS = 150; // 1.5%: a bigger jump in the latency is a chase
const ADD_REAL_SOL = 20; // add once when real reserves cross this
const ADD_BPS = 85; // add 0.85% of real reserves, same headroom as the entry
// --- how a rider leaves -------------------------------------------------------
const TAKE_PROFIT_PCT = 15; // sell when liquidation value is 15% over cost
const STOP_LOSS_PCT = 15; // sell when it is 15% under cost
const TRAIL_ARM_PCT = 30; // trailing stop arms at 30% over cost
const TRAIL_DROP_PCT = 15; // ...then exits on a 15% fall from the peak value
const MAX_HOLD_SLOTS = 600; // sell after holding this long
// --- probe sleeve: guardrail insurance, deliberately tiny ---------------------
const PROBE_SOL = 0.01;
const PROBE_MIN_REAL_SOL = 1.5; // real SOL a curve needs for a 0.01 SOL probe
const PROBE_TARGET = 20; // distinct coins the house wants round-tripped
const PROBE_MAX_OPEN = 1; // most probe positions open at once

interface Curve {
  creator: Pubkey;
  createPrice: number; // virtual quote over virtual token at create
  createdSlot: number | null;
  buyers: Set<Pubkey>;
  creatorSold: boolean;
  entered: boolean; // a rider buy was decided, or the curve completed
}

interface Position {
  openedSlot: number;
  peakValue: bigint; // best liquidation value seen, in lamports
  added: boolean; // the add-on buy was decided
  probe: boolean; // a guardrail probe, not a rider
}

const curves = new Map<Pubkey, Curve>();
const open = new Map<Pubkey, Position>();
/** What a pending buy on a mint is for, so a refused fill can reopen it. */
const buyPurpose = new Map<Pubkey, 'rider' | 'add' | 'probe'>();
/** Lamports of filled buys per mint, and mints with a filled sell leg. */
const boughtLamports = new Map<Pubkey, bigint>();
const soldMints = new Set<Pubkey>();

function curveOf(mint: Pubkey): Curve {
  let c = curves.get(mint);
  if (c === undefined) {
    c = { creator: '', createPrice: 0, createdSlot: null, buyers: new Set(), creatorSold: false, entered: false };
    curves.set(mint, c);
  }
  return c;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees, less one tx fee. */
function sellProceeds(tokens: bigint, vq: bigint, vt: bigint, txFee: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  const fee = (gross * FEE_BPS + 9999n) / 10000n;
  const net = gross - fee - txFee;
  return net > 0n ? net : 0n;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const batchCap = state.hello.caps.max_orders_per_batch;
  const txFee = state.txFeeLamports();
  let cash = state.freeCashLamports();
  let freeSlots = state.hello.caps.max_open_positions - state.committedPositionCount();

  // --- fold this batch's events into the per-curve picture --------------------
  const touched = new Set<Pubkey>();
  for (const event of batch.events) {
    if (event.event === 'CreateEvent') {
      const c = curveOf(event.mint);
      c.creator = event.creator;
      c.createPrice = Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves);
      c.createdSlot = event.slot;
      touched.add(event.mint);
    } else if (event.event === 'TradeEvent') {
      const c = curves.get(event.mint);
      if (c) {
        if (event.is_buy && event.user !== c.creator) c.buyers.add(event.user);
        else if (!event.is_buy && event.user === c.creator) c.creatorSold = true;
      }
      touched.add(event.mint);
    } else if (event.event === 'CompleteEvent') {
      const c = curves.get(event.mint);
      if (c) c.entered = true;
    }
  }

  // --- fold this batch's fills in; a refused buy reopens its slot -----------
  for (const fill of batch.fills) {
    if (fill.side === 'buy' && fill.status === 'filled') {
      boughtLamports.set(fill.mint, (boughtLamports.get(fill.mint) ?? 0n) + BigInt(fill.quote_lamports));
    }
    if (fill.side === 'sell' && fill.status === 'filled') soldMints.add(fill.mint);
    if (fill.side === 'buy' && fill.status !== 'filled') {
      const purpose = buyPurpose.get(fill.mint);
      if (purpose === 'rider') {
        const c = curves.get(fill.mint);
        if (c) c.entered = false;
        open.delete(fill.mint);
      } else if (purpose === 'add') {
        const p = open.get(fill.mint);
        if (p) p.added = false;
      } else if (purpose === 'probe') {
        open.delete(fill.mint);
      }
    }
    if (fill.side === 'buy') buyPurpose.delete(fill.mint);
  }

  const pending = new Set<Pubkey>();
  for (const p of state.pending.values()) pending.add(p.order.mint);

  // --- exits: riders on their rules, probes as soon as the buy lands --------
  for (const [mint, p] of open) {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (!pos) {
      if (!pending.has(mint)) open.delete(mint);
      continue;
    }
    if (!curve || curve.complete) continue;
    const value = sellProceeds(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves, txFee);
    if (value > p.peakValue) p.peakValue = value;
    const cost = pos.cost_lamports;
    let leave = false;
    if (p.probe) leave = true;
    else if (value * 100n >= cost * BigInt(100 + TAKE_PROFIT_PCT)) leave = true;
    else if (value * 100n <= cost * BigInt(100 - STOP_LOSS_PCT)) leave = true;
    else if (p.peakValue * 100n >= cost * BigInt(100 + TRAIL_ARM_PCT) && value * 100n <= p.peakValue * BigInt(100 - TRAIL_DROP_PCT)) leave = true;
    else if (state.slot - p.openedSlot >= MAX_HOLD_SLOTS) leave = true;
    else {
      const c = curves.get(mint);
      if (c && c.creatorSold) leave = true;
    }
    if (!leave) continue;
    if (orders.length >= batchCap) break;
    orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
  }

  // --- the add-on: one more tranche on a rider that keeps climbing -----------
  for (const [mint, p] of open) {
    if (orders.length >= batchCap) break;
    if (p.probe || p.added) continue;
    if (!state.positions.has(mint) || pending.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (!curve || curve.complete) continue;
    if (Number(curve.real_quote_reserves) / LAMPORTS < ADD_REAL_SOL) continue;
    let amount = (curve.real_quote_reserves * BigInt(ADD_BPS)) / 10000n;
    const cap = state.maxBuyLamports(mint);
    if (amount > cap) amount = cap;
    if (amount < MIN_BUY || cash < amount + txFee) continue;
    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
    cash -= amount + txFee;
    buyPurpose.set(mint, 'add');
    p.added = true;
  }

  // --- entries: only curves that have already shown traction -----------------
  for (const mint of touched) {
    if (orders.length >= batchCap || freeSlots <= 0) break;
    if (state.positions.has(mint) || pending.has(mint) || open.has(mint)) continue;
    const c = curves.get(mint)!;
    const curve = state.curves.get(mint);
    if (!curve || curve.complete || c.entered || c.createdSlot === null) continue;
    if (c.creatorSold || c.buyers.size < NEED_BUYERS || c.createPrice <= 0) continue;
    if (Number(curve.real_quote_reserves) / LAMPORTS < NEED_REAL_SOL) continue;
    const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
    if (price < c.createPrice * NEED_RUNUP) continue;
    let amount = (curve.real_quote_reserves * BigInt(BUY_BPS)) / 10000n;
    const cap = state.maxBuyLamports(mint);
    if (amount > cap) amount = cap;
    if (amount < MIN_BUY || cash < amount + txFee) continue;
    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
    cash -= amount + txFee;
    freeSlots--;
    buyPurpose.set(mint, 'rider');
    c.entered = true;
    open.set(mint, { openedSlot: state.slot, peakValue: 0n, added: false, probe: false });
  }

  // --- probes: keep the guardrail count up, one open at a time ---------------
  let covered = 0;
  for (const [m, spent] of boughtLamports) if (spent >= MIN_BUY && soldMints.has(m)) covered++;
  const probesOpen = [...open.values()].filter((p) => p.probe).length;
  if (covered < PROBE_TARGET && probesOpen < PROBE_MAX_OPEN) {
    for (const mint of touched) {
      if (orders.length >= batchCap || freeSlots <= 0) break;
      if (state.positions.has(mint) || pending.has(mint) || open.has(mint) || boughtLamports.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      if (Number(curve.real_quote_reserves) / LAMPORTS < PROBE_MIN_REAL_SOL) continue;
      const amount = LAMPORTS_PER_SOL / 100n;
      if (amount > state.maxBuyLamports(mint) || cash < amount + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      cash -= amount + txFee;
      freeSlots--;
      buyPurpose.set(mint, 'probe');
      open.set(mint, { openedSlot: state.slot, peakValue: 0n, added: false, probe: true });
      break;
    }
  }

  return orders;
}

runBot({ onBatch });
