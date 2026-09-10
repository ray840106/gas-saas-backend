/**
 * 送貨路線最佳化（旅行推銷員問題 TSP 的實務解法）
 *
 * 流程：最近鄰居法產生初始路線 → 2-opt 解開交叉 → Or-opt 微調單點位置。
 * 站點數量在數十個以內時，這組啟發式演算法可以在幾毫秒內得到接近最佳的結果，
 * 而且完全不需要外部 API，沒有金鑰也能運作。
 */

const EARTH_RADIUS_KM = 6371;

/** 兩個經緯度之間的大圓距離（公里） */
function haversineKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 直線距離換算成實際道路里程的修正係數。
 * 台灣市區路網大約是直線距離的 1.3 倍，可用 ROAD_DISTANCE_FACTOR 調整。
 */
function roadFactor() {
  const value = Number(process.env.ROAD_DISTANCE_FACTOR);
  return Number.isFinite(value) && value > 0 ? value : 1.3;
}

/** 建立所有點之間的距離矩陣，index 0 固定是起點（車庫／師傅目前位置） */
function buildDistanceMatrix(points) {
  const factor = roadFactor();
  return points.map((from) =>
    points.map((to) => (from === to ? 0 : haversineKm(from, to) * factor))
  );
}

/** 依照給定順序計算總里程 */
function routeDistance(order, matrix, { closed }) {
  let total = 0;
  for (let i = 0; i < order.length - 1; i += 1) {
    total += matrix[order[i]][order[i + 1]];
  }
  if (closed && order.length > 1) {
    total += matrix[order[order.length - 1]][order[0]];
  }
  return total;
}

/** 最近鄰居法：每次都往最近、還沒去過的點前進 */
function nearestNeighbour(matrix, startIndex) {
  const size = matrix.length;
  const visited = new Array(size).fill(false);
  const order = [startIndex];
  visited[startIndex] = true;

  let current = startIndex;
  for (let step = 1; step < size; step += 1) {
    let best = -1;
    let bestDistance = Infinity;
    for (let candidate = 0; candidate < size; candidate += 1) {
      if (visited[candidate]) continue;
      if (matrix[current][candidate] < bestDistance) {
        bestDistance = matrix[current][candidate];
        best = candidate;
      }
    }
    if (best === -1) break;
    visited[best] = true;
    order.push(best);
    current = best;
  }
  return order;
}

/**
 * 2-opt：反轉路線中的一段，消除路線上的交叉。
 * 起點固定不動，所以外層迴圈從 index 1 開始。
 */
function twoOpt(order, matrix, { closed }) {
  const result = order.slice();
  const last = result.length;
  let improved = true;

  while (improved) {
    improved = false;
    for (let i = 1; i < last; i += 1) {
      for (let k = i + 1; k < last; k += 1) {
        const a = result[i - 1];
        const b = result[i];
        const c = result[k];
        const isTail = !closed && k === result.length - 1;

        // 不回起點時，反轉到最後一站等於換一個收工地點，只需比較前半段
        const delta = isTail
          ? matrix[a][c] - matrix[a][b]
          : matrix[a][c] + matrix[b][result[(k + 1) % result.length]] -
            matrix[a][b] - matrix[c][result[(k + 1) % result.length]];

        if (delta < -1e-9) {
          const segment = result.slice(i, k + 1).reverse();
          result.splice(i, segment.length, ...segment);
          improved = true;
        }
      }
    }
  }
  return result;
}

/** Or-opt：把單一站點搬到別的位置，處理 2-opt 解不掉的「順路漏掉一家」 */
function orOpt(order, matrix, { closed }) {
  const result = order.slice();
  let improved = true;

  while (improved) {
    improved = false;
    const baseline = routeDistance(result, matrix, { closed });

    for (let from = 1; from < result.length; from += 1) {
      for (let to = 1; to < result.length; to += 1) {
        if (from === to) continue;
        const candidate = result.slice();
        const [moved] = candidate.splice(from, 1);
        candidate.splice(to, 0, moved);

        if (routeDistance(candidate, matrix, { closed }) < baseline - 1e-9) {
          result.splice(0, result.length, ...candidate);
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return result;
}

/** 依平均車速與每站作業時間估算所需時間（分鐘） */
function estimateMinutes(distanceKm, stopCount) {
  const speed = Number(process.env.AVERAGE_SPEED_KMH) > 0
    ? Number(process.env.AVERAGE_SPEED_KMH)
    : 25; // 市區載重機車／小貨車的保守估計
  const serviceMinutes = Number(process.env.SERVICE_MINUTES_PER_STOP) >= 0
    ? Number(process.env.SERVICE_MINUTES_PER_STOP)
    : 6; // 搬瓦斯上下車、收款的時間

  return Math.round((distanceKm / speed) * 60 + stopCount * serviceMinutes);
}

/**
 * 排出最佳送貨順序。
 * @param {{lat:number,lng:number}} origin 起點（師傅目前位置或瓦斯行）
 * @param {Array<{lat:number,lng:number}>} stops 各送貨點
 * @param {{returnToOrigin?:boolean}} options 是否要繞回起點
 * @returns {{order:number[], legs:Array, totalDistanceKm:number, estimatedMinutes:number}}
 *          order 是 stops 的索引，已依照建議順序排好
 */
function optimizeRoute(origin, stops, options = {}) {
  const returnToOrigin = Boolean(options.returnToOrigin);

  if (!stops.length) {
    return { order: [], legs: [], totalDistanceKm: 0, estimatedMinutes: 0 };
  }

  const points = [origin, ...stops];
  const matrix = buildDistanceMatrix(points);

  let sequence = nearestNeighbour(matrix, 0);
  sequence = twoOpt(sequence, matrix, { closed: returnToOrigin });
  sequence = orOpt(sequence, matrix, { closed: returnToOrigin });

  const legs = [];
  for (let i = 0; i < sequence.length - 1; i += 1) {
    legs.push({
      fromIndex: sequence[i] - 1, // -1 代表起點
      toIndex: sequence[i + 1] - 1,
      distanceKm: Number(matrix[sequence[i]][sequence[i + 1]].toFixed(2))
    });
  }
  if (returnToOrigin && sequence.length > 1) {
    legs.push({
      fromIndex: sequence[sequence.length - 1] - 1,
      toIndex: -1,
      distanceKm: Number(matrix[sequence[sequence.length - 1]][0].toFixed(2))
    });
  }

  const totalDistanceKm = Number(
    routeDistance(sequence, matrix, { closed: returnToOrigin }).toFixed(2)
  );

  return {
    order: sequence.slice(1).map((index) => index - 1),
    legs,
    totalDistanceKm,
    estimatedMinutes: estimateMinutes(totalDistanceKm, stops.length)
  };
}

module.exports = {
  optimizeRoute,
  haversineKm,
  buildDistanceMatrix,
  routeDistance,
  nearestNeighbour,
  twoOpt,
  orOpt,
  estimateMinutes
};
