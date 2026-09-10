/**
 * 送貨路線規劃的單元測試
 * 執行方式：npm test（不需要資料庫或網路）
 */
const assert = require('assert');

const {
  optimizeRoute,
  haversineKm,
  routeDistance,
  buildDistanceMatrix
} = require('../src/services/routeOptimizer');
const {
  buildNavigationUrl,
  buildDirectionsUrls
} = require('../src/services/googleMaps');
const {
  normalizeOrder,
  groupOrdersByAddress,
  summarizeItems,
  isPending,
  dayRange
} = require('../src/routes/delivery');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ── 距離計算 ──────────────────────────────────────────
test('haversineKm 算得出台北車站到台北 101 的距離（約 4 公里）', () => {
  const taipeiMain = { lat: 25.0478, lng: 121.5170 };
  const taipei101 = { lat: 25.0339, lng: 121.5645 };
  const km = haversineKm(taipeiMain, taipei101);
  assert.ok(km > 4 && km < 5.5, `預期 4~5.5 公里，實際 ${km}`);
});

// ── 路線最佳化 ────────────────────────────────────────
test('optimizeRoute 每一站都只排一次，而且不會漏掉', () => {
  const origin = { lat: 25.03, lng: 121.52 };
  const stops = [
    { lat: 25.05, lng: 121.55 },
    { lat: 25.01, lng: 121.51 },
    { lat: 25.08, lng: 121.60 },
    { lat: 25.02, lng: 121.53 }
  ];
  const plan = optimizeRoute(origin, stops, { returnToOrigin: false });

  assert.strictEqual(plan.order.length, stops.length);
  assert.deepStrictEqual([...plan.order].sort(), [0, 1, 2, 3]);
  assert.strictEqual(plan.legs.length, stops.length);
  assert.ok(plan.totalDistanceKm > 0);
  assert.ok(plan.estimatedMinutes > 0);
});

test('optimizeRoute 排出來的路線不會比原本的下單順序更遠', () => {
  // 故意排成鋸齒狀，模擬「照下單順序跑」會來回折返的情況
  const origin = { lat: 25.000, lng: 121.500 };
  const stops = [
    { lat: 25.040, lng: 121.500 },
    { lat: 25.010, lng: 121.500 },
    { lat: 25.050, lng: 121.500 },
    { lat: 25.020, lng: 121.500 },
    { lat: 25.030, lng: 121.500 }
  ];

  const matrix = buildDistanceMatrix([origin, ...stops]);
  const naive = routeDistance([0, 1, 2, 3, 4, 5], matrix, { closed: false });
  const plan = optimizeRoute(origin, stops, { returnToOrigin: false });

  assert.ok(
    plan.totalDistanceKm <= naive + 1e-6,
    `最佳化後 ${plan.totalDistanceKm} 公里應該不大於原順序 ${naive} 公里`
  );
  // 這組資料的最佳解就是由南往北一路送完
  assert.deepStrictEqual(plan.order, [1, 3, 4, 0, 2]);
});

test('optimizeRoute 要求繞回起點時，會多算一段回程', () => {
  const origin = { lat: 25.00, lng: 121.50 };
  const stops = [
    { lat: 25.02, lng: 121.52 },
    { lat: 25.04, lng: 121.54 }
  ];
  const oneWay = optimizeRoute(origin, stops, { returnToOrigin: false });
  const roundTrip = optimizeRoute(origin, stops, { returnToOrigin: true });

  assert.strictEqual(roundTrip.legs.length, oneWay.legs.length + 1);
  assert.strictEqual(roundTrip.legs[roundTrip.legs.length - 1].toIndex, -1);
  assert.ok(roundTrip.totalDistanceKm > oneWay.totalDistanceKm);
});

test('optimizeRoute 沒有站點時回傳空路線，不會壞掉', () => {
  const plan = optimizeRoute({ lat: 25, lng: 121 }, [], {});
  assert.deepStrictEqual(plan.order, []);
  assert.strictEqual(plan.totalDistanceKm, 0);
});

// ── Google 地圖連結 ───────────────────────────────────
test('buildNavigationUrl 產生可直接開啟導航的連結', () => {
  const url = buildNavigationUrl({ lat: 25.0339, lng: 121.5645 }, { lat: 25.0478, lng: 121.5170 });
  assert.ok(url.startsWith('https://www.google.com/maps/dir/?'));
  assert.ok(url.includes('api=1'));
  assert.ok(url.includes('destination=25.0339%2C121.5645'));
  assert.ok(url.includes('origin=25.0478%2C121.517'));
  assert.ok(url.includes('travelmode=driving'));
});

test('buildNavigationUrl 沒有座標時改用文字地址', () => {
  const url = buildNavigationUrl({ address: '台北市信義區市府路1號' });
  assert.ok(url.includes('destination=%E5%8F%B0%E5%8C%97%E5%B8%82'));
});

test('buildDirectionsUrls 超過 9 個中途點時自動分段，且段與段首尾相接', () => {
  const origin = { lat: 25.00, lng: 121.50, label: '瓦斯行' };
  const stops = Array.from({ length: 12 }, (_, i) => ({
    lat: 25.00 + i * 0.01,
    lng: 121.50 + i * 0.01,
    address: `第 ${i + 1} 站`
  }));

  const segments = buildDirectionsUrls(origin, stops, { returnToOrigin: false });
  assert.ok(segments.length >= 2, '12 站應該要切成兩段以上');

  for (const segment of segments) {
    const waypoints = new URL(segment.url).searchParams.get('waypoints');
    const count = waypoints ? waypoints.split('|').length : 0;
    assert.ok(count <= 9, `單一連結的中途點不得超過 9 個，實際 ${count}`);
  }

  // 第一段從起點出發，最後一段以最後一站作結
  assert.ok(segments[0].url.includes('origin=25%2C121.5'));
  const lastStop = stops[stops.length - 1];
  assert.ok(segments[segments.length - 1].url.includes(`destination=${encodeURIComponent(`${lastStop.lat},${lastStop.lng}`)}`));

  // 前一段的終點就是下一段的起點，師傅才不會漏掉中間那一站
  for (let i = 1; i < segments.length; i += 1) {
    const previousDestination = new URL(segments[i - 1].url).searchParams.get('destination');
    const currentOrigin = new URL(segments[i].url).searchParams.get('origin');
    assert.strictEqual(currentOrigin, previousDestination);
  }
});

test('buildDirectionsUrls 要求回程時，最後會回到起點', () => {
  const origin = { lat: 25.00, lng: 121.50 };
  const stops = [{ lat: 25.01, lng: 121.51 }, { lat: 25.02, lng: 121.52 }];
  const segments = buildDirectionsUrls(origin, stops, { returnToOrigin: true });
  const last = segments[segments.length - 1];
  assert.strictEqual(new URL(last.url).searchParams.get('destination'), '25,121.5');
});

// ── 訂單整理 ──────────────────────────────────────────
test('normalizeOrder 能接受新舊兩種欄位命名', () => {
  const legacy = normalizeOrder({ id: 1, customer_name: '王小明', gas_size: '20kg', quantity: '2', address: ' 台北市中正區 ' });
  assert.strictEqual(legacy.gasWeight, '20');
  assert.strictEqual(legacy.quantity, 2);
  assert.strictEqual(legacy.address, '台北市中正區');
  assert.strictEqual(legacy.status, 'pending');

  const current = normalizeOrder({ id: 2, name: '陳老闆', gas_weight: 16, lat: '25.03', lng: '121.52' });
  assert.strictEqual(current.customerName, '陳老闆');
  assert.strictEqual(current.gasWeight, '16');
  assert.strictEqual(current.lat, 25.03);
});

test('groupOrdersByAddress 把同一個地址的訂單合併成一站', () => {
  const orders = [
    { id: 1, customerName: '王小明', address: '台北市中正區忠孝東路一段1號', quantity: 1, gasWeight: '20' },
    { id: 2, customerName: '林太太', address: '台北市中正區忠孝東路一段  1號', quantity: 2, gasWeight: '16' },
    { id: 3, customerName: '陳老闆', address: '台北市大安區和平東路二段2號', quantity: 1, gasWeight: '20' }
  ];

  const groups = groupOrdersByAddress(orders);
  assert.strictEqual(groups.length, 2, '空白差異不該被當成兩個地址');

  const merged = groups.find((group) => group.orders.length === 2);
  assert.ok(merged, '同地址的兩張訂單應該合併');
  assert.deepStrictEqual(
    summarizeItems(merged.orders).sort((a, b) => a.gasWeight.localeCompare(b.gasWeight)),
    [{ gasWeight: '16', quantity: 2 }, { gasWeight: '20', quantity: 1 }]
  );
});

test('groupOrdersByAddress 會沿用訂單已存好的座標', () => {
  const groups = groupOrdersByAddress([
    { id: 1, customerName: 'A', address: '同一個地址', quantity: 1, lat: null, lng: null },
    { id: 2, customerName: 'B', address: '同一個地址', quantity: 1, lat: 25.03, lng: 121.52 }
  ]);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].lat, 25.03);
});

test('isPending 只排掉已結案的訂單', () => {
  assert.strictEqual(isPending({ status: 'pending' }), true);
  assert.strictEqual(isPending({ status: 'delivering' }), true);
  assert.strictEqual(isPending({}), true, '沒有 status 欄位時視為待配送');
  assert.strictEqual(isPending({ status: 'completed' }), false);
  assert.strictEqual(isPending({ status: '已送達' }), false);
});

test('dayRange 以 +8 時區切出當天的訂單區間', () => {
  process.env.TZ_OFFSET_HOURS = '8';
  const range = dayRange('2026-09-10');
  assert.strictEqual(range.from, '2026-09-09T16:00:00.000Z');
  assert.strictEqual(range.to, '2026-09-10T16:00:00.000Z');
  assert.strictEqual(dayRange('不是日期'), null);
});

// ── 執行 ─────────────────────────────────────────────
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`❌ ${name}\n   ${err.message}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} 項測試通過`);
process.exit(failed ? 1 : 0);
