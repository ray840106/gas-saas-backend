/**
 * 客戶地址簿
 *
 * 讓客戶不用每次叫瓦斯都重打地址：
 *   - 下單時自動把地址存進地址簿，並記成「最近使用」
 *   - 下次開啟 LIFF 直接帶出預設地址，也可以用下拉選單換一個
 *   - 存檔時順便把地址轉成座標，訂單就自帶經緯度，師傅排路線不用再查一次
 */
const geocoding = require('./geocoding');

const ADDRESS_TABLE = process.env.ADDRESS_TABLE || 'gas_customer_address';

/** 依「預設 → 最近使用 → 建立時間」排序，讓下拉選單第一個就是客戶最常用的 */
function sortAddresses(rows) {
  return [...rows].sort((a, b) => {
    if (Boolean(b.isDefault) !== Boolean(a.isDefault)) return b.isDefault ? 1 : -1;
    const timeA = Date.parse(a.lastUsedAt || a.createdAt || 0) || 0;
    const timeB = Date.parse(b.lastUsedAt || b.createdAt || 0) || 0;
    return timeB - timeA;
  });
}

function normalizeRow(row) {
  return {
    id: row.id,
    lineUid: row.line_uid,
    label: row.label || '',
    address: row.address,
    lat: row.lat == null ? null : Number(row.lat),
    lng: row.lng == null ? null : Number(row.lng),
    isDefault: Boolean(row.is_default),
    lastUsedAt: row.last_used_at || null,
    createdAt: row.created_at || null,
    source: 'address-book'
  };
}

/**
 * 把歷史訂單裡出現過、但地址簿還沒收錄的地址補進清單。
 * 這樣就算還沒建地址簿資料表、或是舊客戶，下拉選單一樣有東西可選。
 */
function mergeWithHistory(saved, historyAddresses) {
  const seen = new Set(saved.map((item) => geocoding.normalizeAddress(item.address)));
  const extras = [];

  for (const entry of historyAddresses) {
    const key = geocoding.normalizeAddress(entry.address);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    extras.push({
      id: null,
      lineUid: entry.lineUid || null,
      label: '',
      address: entry.address,
      lat: entry.lat ?? null,
      lng: entry.lng ?? null,
      isDefault: false,
      lastUsedAt: entry.createdAt || null,
      createdAt: entry.createdAt || null,
      source: 'order-history' // 前端可以顯示「來自歷史訂單」
    });
  }

  return sortAddresses([...saved, ...extras]);
}

function createAddressBook(supabase) {
  // 資料表還沒建立時自動降級成「只用歷史訂單」，不讓下單流程壞掉
  let tableAvailable = true;

  function disableTable(error, action) {
    tableAvailable = false;
    console.warn(`⚠️ 地址簿 ${ADDRESS_TABLE} 無法${action}（${error.message}），改用歷史訂單地址`);
  }

  /** 讀取地址簿本身的資料 */
  async function listSaved(lineUid) {
    if (!tableAvailable) return [];

    const { data, error } = await supabase
      .from(ADDRESS_TABLE)
      .select('*')
      .eq('line_uid', lineUid);

    if (error) {
      disableTable(error, '讀取');
      return [];
    }
    return (data || []).map(normalizeRow);
  }

  /** 從歷史訂單撈出這位客戶用過的地址 */
  async function listFromHistory(lineUid, ordersTable) {
    const { data, error } = await supabase
      .from(ordersTable)
      .select('*')
      .eq('line_uid', lineUid)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.warn('⚠️ 讀取歷史訂單地址失敗：', error.message);
      return [];
    }

    return (data || [])
      .filter((row) => row.address)
      .map((row) => ({
        address: String(row.address).trim(),
        lineUid: row.line_uid,
        lat: row.lat ?? null,
        lng: row.lng ?? null,
        createdAt: row.created_at
      }));
  }

  /** 客戶的完整地址清單（地址簿 + 歷史訂單），已排好序 */
  async function list(lineUid, { ordersTable } = {}) {
    const saved = await listSaved(lineUid);
    const history = ordersTable ? await listFromHistory(lineUid, ordersTable) : [];
    return mergeWithHistory(sortAddresses(saved), history);
  }

  /** 查地址座標，查不到就回傳 null（不擋流程） */
  async function locate(address) {
    try {
      return await geocoding.geocodeAddress(address);
    } catch (err) {
      console.warn(`⚠️ 地址定位失敗（${address}）：`, err.message);
      return null;
    }
  }

  /**
   * 存進地址簿（同一位客戶的同一個地址只會有一筆）。
   * @param {boolean} setDefault 是否設成預設地址（下單時一律為 true）
   */
  async function save(lineUid, { address, label = '', setDefault = true } = {}) {
    const cleanAddress = String(address || '').trim();
    if (!lineUid || !cleanAddress) return null;

    const located = await locate(cleanAddress);

    if (!tableAvailable) {
      return {
        id: null,
        lineUid,
        label,
        address: cleanAddress,
        lat: located ? located.lat : null,
        lng: located ? located.lng : null,
        isDefault: setDefault,
        verified: Boolean(located),
        source: 'not-persisted'
      };
    }

    // 換新的預設地址前，先把舊的預設取消掉
    if (setDefault) {
      const { error } = await supabase
        .from(ADDRESS_TABLE)
        .update({ is_default: false })
        .eq('line_uid', lineUid)
        .eq('is_default', true);
      if (error) disableTable(error, '更新');
    }

    if (!tableAvailable) return null;

    const payload = {
      line_uid: lineUid,
      address: cleanAddress,
      is_default: setDefault,
      last_used_at: new Date().toISOString()
    };
    // 沒有帶標籤時不要寫入，免得用既有地址下單反而把客戶取好的名字（住家／店面）洗掉
    if (label) payload.label = label;
    if (located) {
      payload.lat = located.lat;
      payload.lng = located.lng;
    }

    const { data, error } = await supabase
      .from(ADDRESS_TABLE)
      .upsert(payload, { onConflict: 'line_uid,address' })
      .select()
      .maybeSingle();

    if (error) {
      disableTable(error, '寫入');
      return null;
    }

    return { ...normalizeRow(data || payload), verified: Boolean(located) };
  }

  /** 修改標籤、設為預設，或直接刪除 */
  async function update(id, lineUid, changes) {
    if (!tableAvailable) throw new Error(`地址簿 ${ADDRESS_TABLE} 尚未建立，請先執行 sql/002_customer_address.sql`);

    if (changes.isDefault) {
      await supabase
        .from(ADDRESS_TABLE)
        .update({ is_default: false })
        .eq('line_uid', lineUid)
        .eq('is_default', true);
    }

    const payload = {};
    if (changes.label !== undefined) payload.label = changes.label;
    if (changes.isDefault !== undefined) payload.is_default = Boolean(changes.isDefault);
    if (changes.address) {
      payload.address = String(changes.address).trim();
      const located = await locate(payload.address);
      if (located) {
        payload.lat = located.lat;
        payload.lng = located.lng;
      }
    }

    const { data, error } = await supabase
      .from(ADDRESS_TABLE)
      .update(payload)
      .eq('id', id)
      .eq('line_uid', lineUid)
      .select()
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data ? normalizeRow(data) : null;
  }

  async function remove(id, lineUid) {
    if (!tableAvailable) throw new Error(`地址簿 ${ADDRESS_TABLE} 尚未建立，請先執行 sql/002_customer_address.sql`);

    const { error } = await supabase
      .from(ADDRESS_TABLE)
      .delete()
      .eq('id', id)
      .eq('line_uid', lineUid);

    if (error) throw new Error(error.message);
    return true;
  }

  /** 檢查客戶輸入的新地址是否查得到，避免打錯字送出後師傅找不到路 */
  async function verify(address) {
    const cleanAddress = String(address || '').trim();
    if (!cleanAddress) return { verified: false, reason: '請先輸入地址' };

    const located = await locate(cleanAddress);
    if (!located) {
      return { verified: false, reason: '地圖上找不到這個地址，請確認縣市、路名與門牌號碼' };
    }
    return {
      verified: true,
      address: cleanAddress,
      formattedAddress: located.formattedAddress,
      lat: located.lat,
      lng: located.lng
    };
  }

  return { list, listSaved, save, update, remove, verify, get tableAvailable() { return tableAvailable; } };
}

module.exports = { createAddressBook, sortAddresses, mergeWithHistory, normalizeRow, ADDRESS_TABLE };
