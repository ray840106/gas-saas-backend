-- 送貨路線規劃功能所需的資料表調整
-- 在 Supabase 的 SQL Editor 直接執行即可，重複執行不會出錯。

-- 1. 訂單表補上配送需要的欄位
--    status：pending 待配送 / delivering 配送中 / completed 已送達 / cancelled 已取消
alter table if exists public.gas_order
  add column if not exists status text not null default 'pending',
  add column if not exists lat double precision,
  add column if not exists lng double precision,
  add column if not exists phone text,
  add column if not exists note text,
  add column if not exists delivered_at timestamptz;

-- 依狀態與日期查詢待配送訂單會很頻繁，補上索引
create index if not exists gas_order_status_created_idx
  on public.gas_order (status, created_at desc);

-- 2. 地址座標快取：同一個地址只需要向地圖服務問一次，省下 API 費用
create table if not exists public.gas_geocode_cache (
  address text primary key,
  lat double precision not null,
  lng double precision not null,
  formatted_address text,
  provider text,
  created_at timestamptz not null default now()
);
