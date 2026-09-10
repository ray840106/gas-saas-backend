/**
 * Google 地圖相關工具：
 *   1. 產生手機可以直接開啟導航的連結（Universal URL，不需要金鑰）
 *   2. 有 GOOGLE_MAPS_API_KEY 時，改用 Directions API 依照「實際道路」排順序
 */
const fetch = require('cross-fetch');

const DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';

// Google Maps 的 api=1 連結最多只吃 9 個中途點，超過就要分段
const MAX_WAYPOINTS_PER_URL = 9;
// Directions API 免費方案的中途點上限（含 optimize:true）
const MAX_DIRECTIONS_WAYPOINTS = 23;

/** 把座標轉成 Google 連結用的字串，沒有座標時退回文字地址 */
function toPlace(point) {
  if (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) {
    return `${point.lat},${point.lng}`;
  }
  return String((point && point.address) || '').trim();
}

/** 單一站點的導航連結：師傅點下去就直接開始導航 */
function buildNavigationUrl(stop, origin) {
  const params = new URLSearchParams({
    api: '1',
    destination: toPlace(stop),
    travelmode: 'driving'
  });
  if (origin) params.set('origin', toPlace(origin));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * 把整條路線輸出成 Google 地圖連結。
 * 因為 Google 限制 9 個中途點，站點太多時會自動切成好幾段，
 * 每一段的終點就是下一段的起點，師傅跑完一段接著開下一段即可。
 *
 * @returns {Array<{index:number, url:string, fromLabel:string, toLabel:string, stopCount:number}>}
 */
function buildDirectionsUrls(origin, orderedStops, options = {}) {
  const returnToOrigin = Boolean(options.returnToOrigin);
  if (!orderedStops.length) return [];

  const points = [origin, ...orderedStops];
  if (returnToOrigin) points.push(origin);

  const segments = [];
  let cursor = 0;

  while (cursor < points.length - 1) {
    // 一段最多 = 起點 + 9 中途點 + 終點
    const end = Math.min(cursor + MAX_WAYPOINTS_PER_URL + 1, points.length - 1);
    const segment = points.slice(cursor, end + 1);

    const params = new URLSearchParams({
      api: '1',
      origin: toPlace(segment[0]),
      destination: toPlace(segment[segment.length - 1]),
      travelmode: 'driving'
    });

    const waypoints = segment.slice(1, -1).map(toPlace).filter(Boolean);
    if (waypoints.length) params.set('waypoints', waypoints.join('|'));

    segments.push({
      index: segments.length + 1,
      url: `https://www.google.com/maps/dir/?${params.toString()}`,
      fromLabel: segment[0].label || segment[0].address || '起點',
      toLabel: segment[segment.length - 1].label || segment[segment.length - 1].address || '終點',
      // 回程那一段的終點是起點本身，不算一站
      stopCount: segment.slice(1).filter((point) => point !== origin).length
    });

    cursor = end;
  }

  return segments;
}

/**
 * 用 Google Directions API 排順序（optimize:true）。
 * 這是依照真實道路與轉彎限制計算的，比直線距離準確。
 * 沒有金鑰、站點過多或呼叫失敗時回傳 null，讓呼叫端退回本地演算法。
 */
async function optimizeWithGoogle(origin, stops, options = {}) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  if (!stops.length || stops.length > MAX_DIRECTIONS_WAYPOINTS) return null;

  const returnToOrigin = Boolean(options.returnToOrigin);
  // 不回起點時，最後一站要交給 Directions 當終點，但我們希望它也一起被最佳化，
  // 所以把全部站點都放進 waypoints，終點設為起點，再自行決定要不要算回程。
  const params = new URLSearchParams({
    origin: toPlace(origin),
    destination: toPlace(origin),
    waypoints: `optimize:true|${stops.map(toPlace).join('|')}`,
    mode: 'driving',
    language: process.env.GEOCODE_LANGUAGE || 'zh-TW',
    key: apiKey
  });

  const res = await fetch(`${DIRECTIONS_URL}?${params.toString()}`);
  const body = await res.json();

  if (body.status !== 'OK' || !body.routes || !body.routes.length) {
    console.warn(`⚠️ Google Directions 無法排序（${body.status}），改用內建演算法`);
    return null;
  }

  const route = body.routes[0];
  const order = route.waypoint_order || stops.map((_, index) => index);

  // legs 依序是：起點→第1站、第1站→第2站 ... 最後一站→起點
  const legs = route.legs.map((leg) => ({
    distanceKm: Number((leg.distance.value / 1000).toFixed(2)),
    durationMinutes: Math.round(leg.duration.value / 60)
  }));

  const usedLegs = returnToOrigin ? legs : legs.slice(0, -1);
  const totalDistanceKm = Number(
    usedLegs.reduce((sum, leg) => sum + leg.distanceKm, 0).toFixed(2)
  );
  const serviceMinutes = Number(process.env.SERVICE_MINUTES_PER_STOP) >= 0
    ? Number(process.env.SERVICE_MINUTES_PER_STOP)
    : 6;
  const estimatedMinutes =
    usedLegs.reduce((sum, leg) => sum + leg.durationMinutes, 0) + stops.length * serviceMinutes;

  return {
    order,
    legs: usedLegs.map((leg, index) => ({
      fromIndex: index === 0 ? -1 : order[index - 1],
      toIndex: index < order.length ? order[index] : -1,
      distanceKm: leg.distanceKm,
      durationMinutes: leg.durationMinutes
    })),
    totalDistanceKm,
    estimatedMinutes
  };
}

module.exports = {
  buildNavigationUrl,
  buildDirectionsUrls,
  optimizeWithGoogle,
  toPlace,
  MAX_WAYPOINTS_PER_URL
};
