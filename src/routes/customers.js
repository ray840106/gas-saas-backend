/**
 * 客戶地址簿 API
 *
 *   POST   /api/customers/address/verify          檢查地址是否查得到（防打錯字）
 *   GET    /api/customers/:lineUid/addresses      取得常用地址（含歷史訂單地址）
 *   POST   /api/customers/:lineUid/addresses      新增／更新常用地址
 *   PATCH  /api/customers/:lineUid/addresses/:id  改標籤或設為預設
 *   DELETE /api/customers/:lineUid/addresses/:id  刪除
 */
const express = require('express');
const { createAddressBook } = require('../services/addressBook');

const ORDERS_TABLE = process.env.ORDERS_TABLE || 'gas_order';

function createCustomerRouter(supabase, addressBook = createAddressBook(supabase)) {
  const router = express.Router();

  // 地址檢查：客戶按「確認地址」時呼叫，回傳地圖比對到的完整地址
  router.post('/address/verify', async (req, res) => {
    try {
      res.json({ success: true, data: await addressBook.verify(req.body && req.body.address) });
    } catch (err) {
      console.error('❌ 地址檢查失敗:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  router.get('/:lineUid/addresses', async (req, res) => {
    try {
      const addresses = await addressBook.list(req.params.lineUid, { ordersTable: ORDERS_TABLE });
      res.json({ success: true, data: addresses });
    } catch (err) {
      console.error('❌ 讀取地址簿失敗:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  router.post('/:lineUid/addresses', async (req, res) => {
    const { address, label = '', setDefault = true } = req.body || {};
    if (!address || !String(address).trim()) {
      return res.status(400).json({ success: false, message: '請提供地址' });
    }

    try {
      const saved = await addressBook.save(req.params.lineUid, { address, label, setDefault });
      res.json({ success: true, data: saved });
    } catch (err) {
      console.error('❌ 儲存地址失敗:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  router.patch('/:lineUid/addresses/:id', async (req, res) => {
    try {
      const updated = await addressBook.update(req.params.id, req.params.lineUid, req.body || {});
      if (!updated) return res.status(404).json({ success: false, message: '找不到這筆地址' });
      res.json({ success: true, data: updated });
    } catch (err) {
      console.error('❌ 更新地址失敗:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  router.delete('/:lineUid/addresses/:id', async (req, res) => {
    try {
      await addressBook.remove(req.params.id, req.params.lineUid);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ 刪除地址失敗:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  return router;
}

module.exports = { createCustomerRouter };
