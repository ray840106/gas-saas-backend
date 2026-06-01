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
      .from('gas_order')
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 瓦斯行後端 API 伺服器啟動於 port ${port}`);
});