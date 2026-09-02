const IPC_SERIES_URL = 'https://apis.datos.gob.ar/series/api/series?ids=145.3_INGNACUAL_DICI_M_38&limit=500';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

let cache = null;

function monthKey(value) {
  return String(value).slice(0, 7);
}

function shiftMonth(period, offset) {
  const [year, month] = period.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2,'0')}`;
}

function monthsBetween(startPeriod, targetPeriod) {
  const [startYear, startMonth] = startPeriod.split('-').map(Number);
  const [targetYear, targetMonth] = targetPeriod.split('-').map(Number);
  return (targetYear - startYear) * 12 + (targetMonth - startMonth);
}

function roundAmount(value) {
  return Math.round(Number(value) * 100) / 100;
}

async function fetchSeries() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;
  const response = await fetch(IPC_SERIES_URL);
  if (!response.ok) throw new Error(`No se pudo consultar IPC oficial (${response.status}).`);
  const payload = await response.json();
  const series = new Map([['2016-12', 1]]);
  let currentIndex = 1;
  for (const [date, variation] of payload.data || []) {
    currentIndex *= 1 + Number(variation || 0);
    series.set(monthKey(date), currentIndex);
  }
  cache = {
    fetchedAt: Date.now(),
    source: payload.meta?.[1]?.dataset?.source || 'INDEC',
    distributionTitle: payload.meta?.[1]?.distribution?.title || 'IPC Nivel General',
    latestPeriod: payload.data?.length ? monthKey(payload.data[payload.data.length - 1][0]) : null,
    latestVariation: payload.data?.length ? Number(payload.data[payload.data.length - 1][1]) : null,
    series
  };
  return cache;
}

async function latestIpcSummary() {
  const data = await fetchSeries();
  return {
    source: data.source,
    distributionTitle: data.distributionTitle,
    latestPeriod: data.latestPeriod,
    latestVariation: data.latestVariation
  };
}

async function adjustedAmountByIpc(contract, installmentPeriod) {
  if (!contract || contract.adjustment_index !== 'IPC' || !contract.adjustment_frequency_months || !contract.initial_amount || !contract.start_date) {
    return { amount: Number(contract?.initial_amount || 0), applied: false };
  }
  const startPeriod = monthKey(contract.start_date);
  const diff = monthsBetween(startPeriod, installmentPeriod);
  const frequency = Number(contract.adjustment_frequency_months || 0);
  if (diff < frequency) return { amount: Number(contract.initial_amount), applied: false };
  const segment = Math.floor(diff / frequency);
  const effectivePeriod = shiftMonth(startPeriod, segment * frequency);
  const baseRef = shiftMonth(startPeriod, -1);
  const targetRef = shiftMonth(effectivePeriod, -1);
  const data = await fetchSeries();
  const baseIndex = data.series.get(baseRef);
  const targetIndex = data.series.get(targetRef);
  if (!baseIndex || !targetIndex) return { amount: Number(contract.initial_amount), applied: false, pendingOfficialData: true };
  return {
    amount: roundAmount(Number(contract.initial_amount) * (targetIndex / baseIndex)),
    applied: true,
    sourcePeriod: targetRef,
    latestOfficialPeriod: data.latestPeriod
  };
}

module.exports = { latestIpcSummary, adjustedAmountByIpc };
