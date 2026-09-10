/**
 * 送貨路線 API（給送瓦斯的師傅使用）
 *
 *   GET   /api/delivery/config              取得起點預設值與目前使用的地圖服務
 *   GET   /api/delivery/orders              列出可排路線的訂單
 *   POST  /api/delivery/route               依訂單排出最佳送貨順序 + Google 導航連結
 *   PATCH /api/delivery/orders/:id/status   師傅送完一站後回報狀態
 */
const express = require('express');

const geocoding = require('../services/geocoding');
const { optimizeRoute } = require('../services/routeOptimizer');
const googleMaps = require('../services/googleMaps');

// 訂單資料表名稱（目前 LIFF 下單寫入的是 gas_order，可用環境變數覆蓋）
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'gas_order';
const GEOCODE_CACHE_TABLE = process.env.GEOCODE_CACHE_TABLE || 'gas_geocode_cache';

// 已結案的狀態；資料表若還沒有 status 欄位，一律視為待配送
const DONE_STATUSES = ['completed', 'done', 'cancelled', 'canceled', '已送達', '已完成', '已取消'];

/** 資料表欄位名稱在不同版本略有差異，這裡統一成前端好用的格式 */
function normalizeOrder(row) {
  const lat = Number(row.lat ?? row.latitude);
  const lng = Number(row.lng ?? row.longitude);

  return {
    id: row.id,
    lineUid: row.line_uid || null,
    customerName: row.customer_name || row.name || '未命名客戶',
    phone: row.phone || row.customer_phone || null,
    address: (row.address || row.delivery_address || '').trim(),
    gasWeight: String(row.gas_weight ?? row.gas_size ?? '').replace(/kg$/i, ''),
    quantity: Number(row.quantity ?? row.qty ?? 1) || 1,
    status: row.status || 'pending',
    note: row.note || row.remark || null,
    createdAt: row.created_at || null,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null
  };
}

function isPending(order) {
  const status = String(order.status || '').toLowerCase();
  if (!status) return true;
  return !DONE_STATUSES.includes(status);
}

/** 以本地時區（預設 +8）計算某一天的起訖時間，用來篩選當天訂單 */
function dayRange(dateString) {
  const offsetHours = Number.isFinite(Number(process.env.TZ_OFFSET_HOURS))
    ? Number(process.env.TZ_OFFSET_HOURS)
    : 8;
  const start = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;

  start.setUTCHours(start.getUTCHours() - offsetHours);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** 取得預設起點：優先用環境變數設定的瓦斯行位置 */
function depotFromEnv() {
  const lat = Number(process.env.DEPOT_LAT);
  const lng = Number(process.env.DEPOT_LNG);
  const address = process.env.DEPOT_ADDRESS || '';

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng, address, label: process.env.DEPOT_NAME || '瓦斯行' };
  }
  if (address) {
    return { lat: null, lng: null, address, label: process.env.DEPOT_NAME || '瓦斯行' };
  }
  return null;
}

/** 同一個地址的多張訂單合併成一站，師傅一次搬齊 */
function groupOrdersByAddress(orders) {
  const groups = new Map();

  for (const order of orders) {
    const key = geocoding.normalizeAddress(order.address);
    if (!key) continue;

    if (!groups.has(key)) {
      groups.set(key, {
        address: order.address,
        normalizedAddress: key,
        customerName: order.customerName,
        phone: order.phone,
        orders: [],
        lat: order.lat,
        lng: order.lng
      });
    }

    const group = groups.get(key);
    group.orders.push(order);
    // 訂單自帶座標時直接沿用，省下一次地理編碼
    if (group.lat == null && order.lat != null) {
      group.lat = order.lat;
      group.lng = order.lng;
    }
    if (group.customerName !== order.customerName) {
      group.customerName = `${group.customerName} 等 ${group.orders.length} 位`;
    }
  }

  return [...groups.values()];
}

/** 一站要載幾桶、各種規格各幾桶 */
function summarizeItems(orders) {
  const byWeight = new Map();
  for (const order of orders) {
    const weight = order.gasWeight || '未指定';
    byWeight.set(weight, (byWeight.get(weight) || 0) + order.quantity);
  }
  return [...byWeight.entries()].map(([gasWeight, quantity]) => ({ gasWeight, quantity }));
}

function createDeliveryRouter(supabase) {
  const router = express.Router();

  // 把 Supabase 當成地址快取，省下重複的地理編碼費用；資料表不存在就自動停用
  let cacheEnabled = true;
  geocoding.setCacheStore({
    async get(address) {
      if (!cacheEnabled) return null;
      const { data, error } = await supabase
        .from(GEOCODE_CACHE_TABLE)
        .select('lat, lng, formatted_address, provider')
        .eq('address', address)
        .maybeSingle();

      if (error) {
        cacheEnabled = false;
        console.warn(`⚠️ 地址快取表 ${GEOCODE_CACHE_TABLE} 無法使用，改用記憶體快取`);
        return null;
      }
      if (!data) return null;
      return {
        lat: Number(data.lat),
        lng: Number(data.lng),
        formattedAddress: data.formatted_address,
        provider: data.provider
      };
    },
    async set(address, result) {
      if (!cacheEnabled) return;
      const { error } = await supabase.from(GEOCODE_CACHE_TABLE).upsert(
        {
          address,
          lat: result.lat,
          lng: result.lng,
          formatted_address: result.formattedAddress,
          provider: result.provider
        },
        { onConflict: 'address' }
      );
      if (error) cacheEnabled = false;
    }
  });

  /** 共用的訂單查詢 */
  async function fetchOrders({ ids, date, includeDone, limit }) {
    let query = supabase.from(ORDERS_TABLE).select('*');

    if (ids && ids.length) {
      query = query.in('id', ids);
    } else if (date) {
      const range = dayRange(date);
      if (range) query = query.gte('created_at', range.from).lt('created_at', range.to);
    }

    const { data, error } = await query
      .order('created_at', { ascending: true })
      .limit(limit || 200);

    if (error) throw new Error(`讀取訂單失敗：${error.message}`);

    const orders = (data || []).map(normalizeOrder).filter((order) => order.address);
    return includeDone ? orders : orders.filter(isPending);
  }

  // 前端啟動時先問一次：起點預設值、地圖服務、單一連結可放幾站
  router.get('/config', (req, res) => {
    res.json({
      success: true,
      data: {
        depot: depotFromEnv(),
        geocoder: geocoding.resolveProvider(),
        googleDirections: Boolean(process.env.GOOGLE_MAPS_API_KEY),
        maxWaypointsPerLink: googleMaps.MAX_WAYPOINTS_PER_URL,
        ordersTable: ORDERS_TABLE
      }
    });
  });

  // 列出可以排路線的訂單
  router.get('/orders', async (req, res) => {
    try {
      const orders = await fetchOrders({
        date: req.query.date,
        includeDone: req.query.includeDone === 'true',
        limit: Number(req.query.limit) || 200
      });
      res.json({ success: true, data: orders });
    } catch (err) {
      console.error('❌ 讀取待配送訂單失敗:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 🚚 核心：排出最佳路線
  router.post('/route', async (req, res) => {
    try {
      const {
        orderIds,
        origin: originInput,
        returnToOrigin = false,
        date,
        includeDone = false
      } = req.body || {};

      // 1. 取得要送的訂單
      const orders = await fetchOrders({
        ids: Array.isArray(orderIds) ? orderIds : null,
        date,
        includeDone,
        limit: 200
      });

      if (!orders.length) {
        return res.json({
          success: true,
          data: {
            stops: [],
            unresolved: [],
            summary: { stopCount: 0, orderCount: 0, totalDistanceKm: 0, estimatedMinutes: 0, totalCylinders: 0 },
            googleMapsUrls: [],
            message: '目前沒有待配送的訂單'
          }
        });
      }

      // 2. 決定起點：前端傳的目前位置 > 前端傳的地址 > 環境變數的瓦斯行
      let origin = null;
      if (originInput && Number.isFinite(Number(originInput.lat)) && Number.isFinite(Number(originInput.lng))) {
        origin = {
          lat: Number(originInput.lat),
          lng: Number(originInput.lng),
          address: originInput.address || '',
          label: originInput.label || '目前位置'
        };
      } else {
        const fallback = (originInput && originInput.address) ? { address: originInput.address, label: originInput.label || '起點' } : depotFromEnv();
        if (!fallback) {
          return res.status(400).json({
            success: false,
            message: '缺少起點：請提供目前位置座標，或在後端設定 DEPOT_ADDRESS / DEPOT_LAT / DEPOT_LNG'
          });
        }
        const located = await geocoding.geocodeAddress(fallback.address);
        if (!located) {
          return res.status(400).json({ success: false, message: `起點地址無法定位：${fallback.address}` });
        }
        origin = { lat: located.lat, lng: located.lng, address: fallback.address, label: fallback.label || '起點' };
      }

      // 3. 同地址合併成一站，再把地址轉成座標
      const groups = groupOrdersByAddress(orders);
      const needGeocode = groups.filter((group) => group.lat == null).map((group) => group.normalizedAddress);
      const located = await geocoding.geocodeMany(needGeocode);

      const stops = [];
      const unresolved = [];

      for (const group of groups) {
        if (group.lat == null) {
          const hit = located.get(group.normalizedAddress);
          if (hit) {
            group.lat = hit.lat;
            group.lng = hit.lng;
            group.formattedAddress = hit.formattedAddress;
          }
        }

        if (group.lat == null || group.lng == null) {
          unresolved.push({
            address: group.address,
            customerName: group.customerName,
            orderIds: group.orders.map((order) => order.id),
            reason: '地址查不到座標，請確認門牌是否完整'
          });
          continue;
        }
        stops.push(group);
      }

      if (!stops.length) {
        return res.json({
          success: true,
          data: {
            origin,
            stops: [],
            unresolved,
            summary: { stopCount: 0, orderCount: orders.length, totalDistanceKm: 0, estimatedMinutes: 0, totalCylinders: 0 },
            googleMapsUrls: [],
            message: '所有地址都無法定位，請先修正地址'
          }
        });
      }

      // 4. 排序：有 Google 金鑰就用真實道路距離，否則用內建演算法
      let plan = null;
      let provider = 'local';
      try {
        plan = await googleMaps.optimizeWithGoogle(origin, stops, { returnToOrigin });
        if (plan) provider = 'google-directions';
      } catch (err) {
        console.warn('⚠️ Google Directions 呼叫失敗，改用內建演算法：', err.message);
      }
      if (!plan) {
        plan = optimizeRoute(origin, stops, { returnToOrigin });
      }

      // 5. 組裝回傳結果（含每一站的導航連結）
      const legByToIndex = new Map(plan.legs.map((leg) => [leg.toIndex, leg]));
      let accumulatedMinutes = 0;
      const serviceMinutes = Number(process.env.SERVICE_MINUTES_PER_STOP) >= 0
        ? Number(process.env.SERVICE_MINUTES_PER_STOP)
        : 6;
      const averageSpeedKmh = Number(process.env.AVERAGE_SPEED_KMH) > 0
        ? Number(process.env.AVERAGE_SPEED_KMH)
        : 25;

      const orderedStops = plan.order.map((stopIndex, position) => {
        const group = stops[stopIndex];
        const leg = legByToIndex.get(stopIndex);
        const previous = position === 0 ? origin : stops[plan.order[position - 1]];
        const driveMinutes = leg && leg.durationMinutes != null
          ? leg.durationMinutes
          : Math.round(((leg ? leg.distanceKm : 0) / averageSpeedKmh) * 60);

        accumulatedMinutes += driveMinutes + (position === 0 ? 0 : serviceMinutes);

        return {
          seq: position + 1,
          customerName: group.customerName,
          phone: group.phone,
          address: group.address,
          formattedAddress: group.formattedAddress || group.address,
          lat: group.lat,
          lng: group.lng,
          orderIds: group.orders.map((order) => order.id),
          orders: group.orders,
          items: summarizeItems(group.orders),
          totalCylinders: group.orders.reduce((sum, order) => sum + order.quantity, 0),
          distanceFromPrevKm: leg ? leg.distanceKm : null,
          etaMinutes: accumulatedMinutes,
          navigationUrl: googleMaps.buildNavigationUrl(group, previous)
        };
      });

      const googleMapsUrls = googleMaps.buildDirectionsUrls(
        origin,
        plan.order.map((index) => stops[index]),
        { returnToOrigin }
      );

      res.json({
        success: true,
        data: {
          origin,
          provider,
          returnToOrigin,
          stops: orderedStops,
          unresolved,
          googleMapsUrls,
          summary: {
            stopCount: orderedStops.length,
            orderCount: orderedStops.reduce((sum, stop) => sum + stop.orderIds.length, 0),
            unresolvedCount: unresolved.reduce((sum, item) => sum + item.orderIds.length, 0),
            totalDistanceKm: plan.totalDistanceKm,
            estimatedMinutes: plan.estimatedMinutes,
            totalCylinders: orderedStops.reduce((sum, stop) => sum + stop.totalCylinders, 0)
          }
        }
      });
    } catch (err) {
      console.error('❌ 路線規劃失敗:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 師傅回報：出發 / 送達
  router.patch('/orders/:id/status', async (req, res) => {
    const { status } = req.body || {};
    const allowed = ['pending', 'delivering', 'completed', 'cancelled'];

    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: `status 必須是 ${allowed.join(' / ')}` });
    }

    try {
      const { data, error } = await supabase
        .from(ORDERS_TABLE)
        .update({ status })
        .eq('id', req.params.id)
        .select();

      if (error) {
        // 資料表還沒有 status 欄位時給出明確指示
        if (/column .*status.* does not exist/i.test(error.message)) {
          return res.status(400).json({
            success: false,
            message: `資料表 ${ORDERS_TABLE} 缺少 status 欄位，請先執行 sql/001_delivery_route.sql`
          });
        }
        throw new Error(error.message);
      }

      res.json({ success: true, data: (data || []).map(normalizeOrder) });
    } catch (err) {
      console.error('❌ 更新訂單狀態失敗:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  return router;
}

module.exports = {
  createDeliveryRouter,
  normalizeOrder,
  groupOrdersByAddress,
  summarizeItems,
  isPending,
  dayRange
};
