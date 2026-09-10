# 瓦斯行後端 API

Express + Supabase + LINE Messaging API。

```bash
npm install
npm start     # 啟動 API（預設 port 3000）
npm test      # 執行送貨路線的單元測試（不需要資料庫或網路）
```

環境變數請參考 [`.env.example`](./.env.example)。

---

## 🚚 送貨路線規劃 API

給送瓦斯的師傅使用：把待配送的訂單排成最短的送貨順序，並產生 Google 地圖導航連結。

### 設計重點

- **同地址自動併站**：同一棟樓的三張訂單只會出現一站，師傅一次搬齊。
- **沒有 Google 金鑰也能用**：預設用 OpenStreetMap／Nominatim 查座標 + 內建 TSP 演算法排序；
  設定 `GOOGLE_MAPS_API_KEY` 後自動升級為 Google Geocoding + Directions API（依實際道路與路況）。
- **地址座標會快取**：查過的地址存進 `gas_geocode_cache`，同一個客戶不會重複消耗 API 額度。
- **導航連結不需金鑰**：使用 Google Maps 的 [Universal URL](https://developers.google.com/maps/documentation/urls/get-started)，
  手機點下去直接開啟 Google 地圖 App 導航。

### 事前準備

在 Supabase 的 SQL Editor 執行 [`sql/001_delivery_route.sql`](./sql/001_delivery_route.sql)，
幫訂單表補上 `status`／`lat`／`lng` 等欄位，並建立地址快取表。
（沒執行也能排路線，只是無法回報「已送達」狀態。）

### 端點

#### `GET /api/delivery/config`

回傳起點預設值與目前使用的地圖服務，前端啟動時呼叫一次。

#### `GET /api/delivery/orders?date=2026-09-10`

列出可以排路線的訂單（已完成／已取消的會自動排除）。`date` 省略時回傳全部未完成訂單。

#### `POST /api/delivery/route`

排出最佳送貨順序。

```jsonc
// request
{
  "orderIds": [12, 15, 18],              // 省略則自動抓全部未完成訂單
  "origin": { "lat": 25.047, "lng": 121.517, "label": "目前位置" },
                                          // 也可以傳 { "address": "..." }；
                                          // 都不傳時使用 DEPOT_* 設定的瓦斯行位置
  "returnToOrigin": false,                // 是否要把回程里程算進去
  "date": "2026-09-10"                    // 搭配 orderIds 省略時使用
}
```

```jsonc
// response.data
{
  "provider": "google-directions",        // 或 "local"（內建演算法）
  "origin": { "lat": 25.047, "lng": 121.517, "label": "目前位置" },
  "stops": [
    {
      "seq": 1,
      "customerName": "王小明 等 2 位",
      "address": "台北市中正區忠孝東路一段1號",
      "lat": 25.0448, "lng": 121.517,
      "orderIds": [12, 15],
      "items": [{ "gasWeight": "20", "quantity": 3 }],
      "totalCylinders": 3,
      "distanceFromPrevKm": 0.43,
      "etaMinutes": 1,                    // 從出發時間起算
      "navigationUrl": "https://www.google.com/maps/dir/?api=1&..."
    }
  ],
  "unresolved": [                          // 地址查不到座標，需要人工修正
    { "address": "火星一號", "customerName": "…", "orderIds": [20], "reason": "…" }
  ],
  "googleMapsUrls": [                      // 整趟路線；超過 9 個中途點會自動分段
    { "index": 1, "url": "https://www.google.com/maps/dir/?api=1&...", "stopCount": 9,
      "fromLabel": "目前位置", "toLabel": "台北市…" }
  ],
  "summary": {
    "stopCount": 6, "orderCount": 7, "unresolvedCount": 1,
    "totalDistanceKm": 21.61, "estimatedMinutes": 88, "totalCylinders": 11
  }
}
```

#### `PATCH /api/delivery/orders/:id/status`

師傅送達後回報狀態：`{ "status": "pending" | "delivering" | "completed" | "cancelled" }`。

### 演算法說明

`src/services/routeOptimizer.js` 用的是實務上最常見的組合：

1. **最近鄰居法**產生初始路線（每次往最近、還沒去過的點前進）
2. **2-opt** 反轉路段，消除路線交叉
3. **Or-opt** 把單一站點搬到更順的位置

距離用 Haversine 公式算直線距離，再乘上 `ROAD_DISTANCE_FACTOR`（預設 1.3）估算實際道路里程。
站點數量在數十個以內時，可以在幾毫秒內得到接近最佳的路線。
