require('cross-fetch/polyfill');

// 🌟 補丁二：解決 Node.js 16 缺少 WebSocket 的問題
global.WebSocket = require('ws');

require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const { createClient } = require('@supabase/supabase-js');

// 為了讓後端運行更穩定，我們在連線設定裡關閉瀏覽器專用的 persistSession
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: { persistSession: false }
});

// 訂單資料表名稱集中在這裡，避免寫入與讀取指到不同張表
const ORDER_TABLE = 'gas_order';

const ORDER_STATUSES = ['pending', 'delivering', 'completed'];

// gas_order.status 的欄位預設值連同單引號一起存成 'pending'，
// 比對前一律先正規化，否則 status 的判斷全部會失準。
function normalizeStatus(value) {
  const text = String(value ?? '').trim().replace(/^'(.*)'$/, '$1').trim();
  return ORDER_STATUSES.includes(text) ? text : 'pending';
}

// Google Maps 導航連結。用的是免費的 Maps URLs 格式，
// 不需要 API key、不需要開通帳單，地址直接用字串讓 Google 自己解析。
function mapsUrlFor(address) {
  return 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' +
    encodeURIComponent(address);
}

// 一條 Maps 連結能塞的中繼點上限。
// ⚠️ 這個數字請對照 Google Maps URLs 官方文件確認，超過的部分會被截斷。
const MAX_WAYPOINTS = 9;

// ===== LINE 身分驗證 =======================================================

// 師傅白名單。多個 UID 用逗號分隔：DRIVER_UIDS=U1aad...,U2bbc...
// 取得師傅 UID 的方法：請他加本 bot 好友並隨便傳一句話，
// bot 的回覆裡就有他的專屬 ID，複製貼進這個環境變數即可。
const DRIVER_UIDS = String(process.env.DRIVER_UIDS || '')
  .split(',')
  .map((uid) => uid.trim())
  .filter(Boolean);

// LIFF ID 的格式是「{channelId}-{suffix}」，前面那段數字就是 LINE Login
// 的 Channel ID。一定要比對它，否則別的 channel 簽出來的 token 也會被
// 當成合法的。（請到 LINE Developers Console 再確認一次這個數字。）
const LINE_LOGIN_CHANNEL_ID = String(process.env.LINE_LOGIN_CHANNEL_ID || '').trim();

// LINE API 的位址。獨立成變數是為了讓這段驗證邏輯能在本機用假的 LINE
// 端點測試 —— 安全性的程式碼只靠讀是看不出漏洞的。正式環境不要設定它。
const LINE_API_BASE = process.env.LINE_API_BASE || 'https://api.line.me';

// 用 access token 向 LINE 換取真實身分。
// ⚠️ 使用者是誰一律以這裡的回傳為準，絕不能相信前端自己送上來的 userId
//    字串 —— UID 不是機密（本 bot 還會主動回覆給每個加好友的人），
//    任何人都能偽造，那種做法等於把鑰匙印在門上。
async function resolveLineUser(accessToken) {
  // 第一步：確認 token 是 LINE 簽的、沒過期，而且屬於我們自己的 channel
  const verifyRes = await fetch(
    LINE_API_BASE + '/oauth2/v2.1/verify?access_token=' + encodeURIComponent(accessToken)
  );

  if (!verifyRes.ok) {
    throw Object.assign(new Error('登入資訊無效或已過期，請重新開啟頁面'), { status: 401 });
  }

  const verified = await verifyRes.json();

  if (String(verified.client_id) !== LINE_LOGIN_CHANNEL_ID) {
    console.warn(`⛔ token 屬於其他 channel (${verified.client_id})，已拒絕`);
    throw Object.assign(new Error('登入資訊不屬於本服務'), { status: 401 });
  }

  // 第二步：換取使用者資料，userId 從這裡拿才可信
  const profileRes = await fetch(LINE_API_BASE + '/v2/profile', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!profileRes.ok) {
    throw Object.assign(new Error('無法取得 LINE 使用者資料'), { status: 401 });
  }

  return profileRes.json();
}

// 只放行白名單上的師傅
async function requireDriver(req, res, next) {
  // 設定不完整時一律擋下。安全檢查寧可整個壞掉，也不要悄悄放行。
  if (!LINE_LOGIN_CHANNEL_ID || DRIVER_UIDS.length === 0) {
    console.error('⛔ 尚未設定 LINE_LOGIN_CHANNEL_ID 或 DRIVER_UIDS，師傅 API 一律拒絕');
    return res.status(500).json({
      success: false,
      message: '伺服器尚未設定配送人員名單，請聯絡管理者'
    });
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({ success: false, message: '缺少身分驗證資訊' });
  }

  try {
    const profile = await resolveLineUser(token);

    if (!DRIVER_UIDS.includes(profile.userId)) {
      console.warn(`⛔ 非配送人員嘗試存取：${profile.displayName} (${profile.userId})`);
      return res.status(403).json({
        success: false,
        message: '您不在配送人員名單中',
        // 回傳他自己的 UID，方便他直接把這串字給老闆加進名單
        line_uid: profile.userId,
        display_name: profile.displayName
      });
    }

    req.driver = profile;
    next();
  } catch (err) {
    console.error('身分驗證失敗:', err.message);
    res.status(err.status || 401).json({ success: false, message: err.message });
  }
}

// 2. LINE 金鑰設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// 使用 v7 標準客戶端初始化
const client = new line.Client(config);
const app = express();

// 3. 照妖鏡：攔截所有進來的請求
app.post('/webhook', (req, res, next) => {
  console.log('\n====================================');
  console.log('📡 偵測到 LINE 伺服器敲門了！');
  console.log('====================================');
  next();
}, 
// 4. LINE 的安全檢查中間件
line.middleware(config), 
// 5. 通過檢查後的路由處理
(req, res) => {
  console.log('✅ 成功通過安全檢查！');

  if (req.body.events.length === 0) {
    console.log('⚠️ 收到空事件 (LINE Webhook 驗證測試，無須理會)');
    return res.json({});
  }

  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('❌ 處理訊息發生錯誤:', err);
      res.status(500).end();
    });
});

// 6. 錯誤處理中間件（捕捉簽章驗證失敗）
app.use((err, req, res, next) => {
  if (err instanceof line.SignatureValidationFailed) {
    console.error('⛔ 簽章驗證失敗！請檢查 .env 裡的 CHANNEL_SECRET！');
    res.status(401).send(err.signatureValidationFailed);
  } else {
    next(err);
  }
});

// 7. 🌟 事件處理核心 (加入 async 支援資料庫操作)
async function handleEvent(event) {
  // 只處理文字訊息
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userId = event.source.userId;
  const userText = event.message.text;
  console.log(`\n👤 [新事件] 抓到客人 UID: ${userId}`);
  console.log(`💬 客人說: ${userText}`);

  // 🌟 將客人的 UID 寫入 Supabase 資料庫
  // upsert: 如果 line_uid 不存在就新增，存在就更新 (onConflict 指定比對欄位)
  const { data, error } = await supabase
    .from('gas_customer')
    .upsert({ line_uid: userId }, { onConflict: 'line_uid' });

  if (error) {
    console.error('❌ 資料庫寫入失敗:', error);
  } else {
    console.log('✅ 客戶資料已成功同步至 Supabase！');
  }

  // 準備回覆給客人的文字
  const echoText = `老闆好！您的資料已經自動建檔完畢！\n您的專屬 ID 是：\n${userId}\n\n未來可以直接在這裡呼叫快速派單喔！`;

  // 回覆訊息給客人
  return client.replyMessage(event.replyToken, [
    {
      type: 'text',
      text: echoText
    }
  ]).then(() => {
    console.log('📤 訊息回覆成功！');
  }).catch((err) => {
    console.error('⛔ 回覆失敗！');
    if (err.backgroundImage === undefined && err.statusCode) {
      console.error(`HTTP 狀態碼: ${err.statusCode}`);
    }
  });
}

// 🌟 1. 載入並啟用 CORS，允許前端跨網域呼叫 API
const cors = require('cors');
app.use(cors());

// 🌟 2. 讓 Express 能夠解析前端傳來的 JSON 資料 
// (⚠️ 注意：這行一定要放在 webhook 路由的後面，才不會破壞 LINE 的原始資料驗證)
app.use(express.json());

// 🌟 3. 接收點餐 API (升級版：包含完整表單資料)
app.post('/api/order', async (req, res) => {
  try {
    // 從前端接收所有欄位
    const { userId, displayName, gasWeight, quantity, address } = req.body;

    console.log(`📦 收到新訂單：${displayName} 叫了 ${quantity} 桶 ${gasWeight}kg，送到 ${address}`);
    
    // 寫入 Supabase
    const { data, error } = await supabase
      .from(ORDER_TABLE)
      .insert([
        { 
          line_uid: userId, 
          customer_name: displayName,
          gas_weight: String(gasWeight),
          quantity: Number(quantity),
          address: address
        }
      ]);

    if (error) throw error; 

    // 客製化 LINE 推播訊息
    const orderDetails = `收到新訂單！🔥\n\n` +
                         `👤 顧客：${displayName}\n` +
                         `📦 規格：${gasWeight} 公斤\n` +
                         `🔢 數量：${quantity} 桶\n` +
                         `📍 送達地址：${address}\n\n` +
                         `我們會盡快為您安排派送！🚚💨`;

    await client.pushMessage(userId, {
      type: 'text',
      text: orderDetails
    });

    res.status(200).json({ success: true });

  } catch (err) {
    console.error('❌ API 處理失敗:', err);
    res.status(500).json({ success: false, message: '伺服器內部錯誤' });
  }
});

// 取得所有瓦斯訂單 (從新到舊排序)
app.get('/api/orders', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from(ORDER_TABLE)
      .select('*')
      .order('created_at', { ascending: false }); // 讓最新建立的訂單排在最上面

    // 如果 Supabase 報錯
    if (error) {
      console.error('Supabase 撈取訂單失敗:', error);
      return res.status(500).json({ success: false, message: error.message });
    }

    // 成功回傳資料
    res.json({ success: true, data: data });
    
  } catch (err) {
    console.error('伺服器錯誤:', err);
    res.status(500).json({ success: false, message: '伺服器內部錯誤' });
  }
});

// 🚚 師傅的配送清單：回傳尚未送達的訂單，並附上可直接點開的導航連結。
// 目前還沒有經緯度，所以順序就是下單先後（舊的排前面），沒有做路徑最佳化。
// 之後要加最佳化時，只要換掉這裡的排序邏輯，前端不用動。
app.get('/api/route', requireDriver, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from(ORDER_TABLE)
      .select('*')
      .order('created_at', { ascending: true }); // 先下單的先送

    if (error) {
      console.error('Supabase 撈取配送清單失敗:', error);
      return res.status(500).json({ success: false, message: error.message });
    }

    // status 要正規化之後才能篩，資料表裡存的可能是帶引號的 'completed'
    const pending = (data || []).filter((row) => normalizeStatus(row.status) !== 'completed');

    const stops = [];
    const unroutable = [];

    for (const row of pending) {
      const address = String(row.address || '').trim();
      const base = {
        order_id: row.id,
        order_no: `ORD-${String(row.id).padStart(3, '0')}`,
        customer_name: row.customer_name || '未填寫',
        address,
        gas_weight: row.gas_weight,
        quantity: Number(row.quantity) || 1,
        status: normalizeStatus(row.status)
      };

      // 地址是空的就導不了航。這種單子絕對不能默默消失，
      // 否則師傅根本不知道有這一單，客人就收不到瓦斯。
      if (!address) {
        unroutable.push({ ...base, reason: 'missing_address' });
      } else {
        stops.push({ ...base, seq: stops.length + 1, maps_url: mapsUrlFor(address) });
      }
    }

    // 把整條路線一次丟給 Google Maps：最後一站當終點，其餘當中繼點。
    // Google 不會幫忙重排順序，它就照我們給的順序走。
    let fullRouteUrl = null;
    let truncated = false;

    if (stops.length >= 2) {
      const usable = stops.slice(0, MAX_WAYPOINTS + 1);
      truncated = stops.length > usable.length;
      const destination = usable[usable.length - 1].address;
      const waypoints = usable.slice(0, -1).map((stop) => stop.address);
      fullRouteUrl =
        'https://www.google.com/maps/dir/?api=1&travelmode=driving' +
        '&destination=' + encodeURIComponent(destination) +
        '&waypoints=' + waypoints.map(encodeURIComponent).join('|');
    } else if (stops.length === 1) {
      fullRouteUrl = stops[0].maps_url;
    }

    res.json({
      success: true,
      optimized: false, // 還沒接 geocoding，順序不是最佳化過的
      stops,
      unroutable,
      total_stops: stops.length,
      full_route_maps_url: fullRouteUrl,
      full_route_truncated: truncated
    });
  } catch (err) {
    console.error('伺服器錯誤:', err);
    res.status(500).json({ success: false, message: '伺服器內部錯誤' });
  }
});

// 更新單筆訂單的狀態（師傅按「已送達」會打這支）
app.patch('/api/orders/:id/status', requireDriver, async (req, res) => {
  try {
    const { status } = req.body;

    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `status 只能是 ${ORDER_STATUSES.join(' / ')}`
      });
    }

    const { data, error } = await supabase
      .from(ORDER_TABLE)
      .update({ status })
      .eq('id', req.params.id)
      .select();

    if (error) {
      console.error('Supabase 更新訂單狀態失敗:', error);
      return res.status(500).json({ success: false, message: error.message });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ success: false, message: '找不到這筆訂單' });
    }

    console.log(`📌 訂單 ${req.params.id} 由 ${req.driver.displayName} 標記為 ${status}`);
    res.json({ success: true, data: data[0] });
  } catch (err) {
    console.error('伺服器錯誤:', err);
    res.status(500).json({ success: false, message: '伺服器內部錯誤' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 瓦斯行後端 API 伺服器啟動於 port ${port}`);

  if (!LINE_LOGIN_CHANNEL_ID || DRIVER_UIDS.length === 0) {
    console.warn('⚠️  師傅 API 目前無法使用：請設定 LINE_LOGIN_CHANNEL_ID 與 DRIVER_UIDS');
  } else {
    console.log(`👷 已載入 ${DRIVER_UIDS.length} 位配送人員的白名單`);
  }
});