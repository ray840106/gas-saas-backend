/**
 * 地址轉座標 (Geocoding)
 *
 * 支援兩種來源，會依照環境變數自動挑選：
 *   1. Google Geocoding API（設定 GOOGLE_MAPS_API_KEY 時使用，準確度最高）
 *   2. Nominatim / OpenStreetMap（免金鑰的備援，有每秒 1 次的禮貌性限制）
 *
 * 為了不浪費 API 額度，查過的地址會先存在記憶體，
 * 也可以再接一層資料庫快取（見 setCacheStore）。
 */
const fetch = require('cross-fetch');

const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const REGION = (process.env.GEOCODE_REGION || 'tw').toLowerCase();
const LANGUAGE = process.env.GEOCODE_LANGUAGE || 'zh-TW';
const COUNTRY_SUFFIX = process.env.GEOCODE_COUNTRY_SUFFIX || '台灣';

// 記憶體快取：normalizedAddress -> { lat, lng, formattedAddress, provider }
const memoryCache = new Map();

// 選用的外部快取（例如 Supabase 資料表），由呼叫端注入
let cacheStore = null;

/**
 * 注入外部快取。store 需提供 get(address) 與 set(address, result) 兩個方法，
 * 兩者都可以是 async，失敗時只會寫 log 不會中斷流程。
 */
function setCacheStore(store) {
  cacheStore = store;
}

/**
 * 把地址正規化，讓「台北市  信義區 1號」和「臺北市信義區１號」共用同一份快取：
 *   1. 全形數字、英文字母轉半形
 *   2. 臺 → 台
 *   3. 中文地址本來就不用空白，全部拿掉；英文地址則只壓縮成單一空白
 */
function normalizeAddress(address) {
  let value = String(address || '')
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/臺/g, '台')
    .replace(/[，,]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (/[\u4e00-\u9fff]/.test(value)) {
    value = value.replace(/\s+/g, '');
  }
  return value;
}

/** 判斷目前該用哪一個地理編碼服務 */
function resolveProvider() {
  const forced = (process.env.GEOCODER || 'auto').toLowerCase();
  if (forced === 'google') return 'google';
  if (forced === 'nominatim') return 'nominatim';
  return process.env.GOOGLE_MAPS_API_KEY ? 'google' : 'nominatim';
}

// Nominatim 規定每秒最多 1 次請求，用一條 Promise 鏈把請求排隊
let nominatimQueue = Promise.resolve();
function throttleNominatim(task) {
  const run = nominatimQueue.then(task, task);
  nominatimQueue = run.then(
    () => new Promise((resolve) => setTimeout(resolve, 1100)),
    () => new Promise((resolve) => setTimeout(resolve, 1100))
  );
  return run;
}

async function geocodeWithGoogle(address) {
  const params = new URLSearchParams({
    address,
    region: REGION,
    language: LANGUAGE,
    key: process.env.GOOGLE_MAPS_API_KEY
  });

  const res = await fetch(`${GOOGLE_GEOCODE_URL}?${params.toString()}`);
  const body = await res.json();

  if (body.status === 'ZERO_RESULTS') return null;
  if (body.status !== 'OK') {
    throw new Error(`Google Geocoding 失敗：${body.status} ${body.error_message || ''}`.trim());
  }

  const best = body.results[0];
  return {
    lat: best.geometry.location.lat,
    lng: best.geometry.location.lng,
    formattedAddress: best.formatted_address,
    provider: 'google'
  };
}

async function geocodeWithNominatim(address) {
  // Nominatim 對中文地址的容錯較差，補上國名可以大幅提升命中率
  const query = /台灣|臺灣|taiwan/i.test(address) ? address : `${address}, ${COUNTRY_SUFFIX}`;
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    limit: '1',
    'accept-language': LANGUAGE
  });
  if (REGION) params.set('countrycodes', REGION);

  const res = await throttleNominatim(() =>
    fetch(`${NOMINATIM_URL}?${params.toString()}`, {
      headers: {
        // Nominatim 使用政策要求帶上可識別的 User-Agent
        'User-Agent': process.env.NOMINATIM_USER_AGENT || 'gas-saas-delivery-routing/1.0'
      }
    })
  );

  if (!res.ok) throw new Error(`Nominatim 回應異常：HTTP ${res.status}`);

  const body = await res.json();
  if (!Array.isArray(body) || body.length === 0) return null;

  return {
    lat: Number(body[0].lat),
    lng: Number(body[0].lon),
    formattedAddress: body[0].display_name,
    provider: 'nominatim'
  };
}

/**
 * 查詢單一地址的座標。
 * @returns {Promise<{lat:number,lng:number,formattedAddress:string,provider:string}|null>}
 *          查不到時回傳 null（不是丟例外），方便呼叫端把它列進「待補地址」。
 */
async function geocodeAddress(address) {
  const key = normalizeAddress(address);
  if (!key) return null;

  if (memoryCache.has(key)) return memoryCache.get(key);

  if (cacheStore) {
    try {
      const cached = await cacheStore.get(key);
      if (cached) {
        memoryCache.set(key, cached);
        return cached;
      }
    } catch (err) {
      console.warn('⚠️ 讀取地址快取失敗，改為即時查詢：', err.message);
    }
  }

  const provider = resolveProvider();
  const result = provider === 'google'
    ? await geocodeWithGoogle(key)
    : await geocodeWithNominatim(key);

  if (!result) return null;

  memoryCache.set(key, result);
  if (cacheStore) {
    try {
      await cacheStore.set(key, result);
    } catch (err) {
      console.warn('⚠️ 寫入地址快取失敗（不影響本次排路線）：', err.message);
    }
  }
  return result;
}

/**
 * 批次查詢地址。
 * @returns {Promise<Map<string, object|null>>} key 為正規化後的地址
 */
async function geocodeMany(addresses) {
  const unique = [...new Set(addresses.map(normalizeAddress).filter(Boolean))];
  const results = new Map();

  for (const address of unique) {
    try {
      results.set(address, await geocodeAddress(address));
    } catch (err) {
      console.error(`❌ 地址定位失敗（${address}）：`, err.message);
      results.set(address, null);
    }
  }
  return results;
}

module.exports = {
  geocodeAddress,
  geocodeMany,
  normalizeAddress,
  resolveProvider,
  setCacheStore
};
