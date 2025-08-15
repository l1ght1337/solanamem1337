// Простая модель цели и интенсивности потока «толпы».
// Генерирует "target price" и интенсивность заявок в зависимости от Market shape.

export type MarketShape = 'pump' | 'range' | 'unwind';

export type AITick = {
  target: number;       // целевой mid
  intensity: number;    // 0..1 интенсивность агрессивных рыночных
  sigma: number;        // оценка волатильности (для MM)
};

export interface AIParams {
  shape: MarketShape;
  startPrice: number;
  t0: number;           // ms
  pressure: number;     // -1..+1 ручной сдвиг
}

export function aiTick(params: AIParams, now = Date.now()): AITick {
  const { shape, startPrice, t0, pressure } = params;
  const dt = Math.max(0, now - t0) / 1000; // сек
  const baseSigma = 0.012; // ~1.2% минутная

  let drift = 0;
  let trend = 0;
  let intensity = 0.3;

  switch (shape) {
    case 'pump': {
      // Логистическая кривая + локальные всплески
      const k = 0.015;                    // скорость
      const amp = 12;                     // амплитуда роста
      const logistic = amp / (1 + Math.exp(-k * (dt - 90)));
      drift = logistic;
      trend = 0.006;                      // постоянный снос вверх
      intensity = 0.55;
      break;
    }
    case 'range': {
      // Нулевой дрейф, синусоидальные колебания вокруг старта
      drift = 0.6 * Math.sin(dt / 30);
      trend = 0.0;
      intensity = 0.25;
      break;
    }
    case 'unwind': {
      // Затухающий экспоненциальный спад
      const A = 6;
      const lambda = 0.012;
      drift = -A * (1 - Math.exp(-lambda * dt));
      trend = -0.004;
      intensity = 0.45;
      break;
    }
  }

  // ручной "pressure" от оператора
  const manual = pressure * 4;

  const rel = (drift + trend * dt + manual) / 100; // относительное изменение
  const target = startPrice * (1 + rel);
  const sigma = baseSigma * (1 + Math.abs(manual) * 0.4);

  // clamp
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  return { target, intensity: clamp01(intensity + Math.abs(pressure) * 0.15), sigma };
}
