type LayoutMeasurement = () => void;

const measurementsByElement = new Map<Element, Set<LayoutMeasurement>>();
const pendingMeasurements = new Set<LayoutMeasurement>();
let observer: ResizeObserver | undefined;
let measurementFrame: number | undefined;

const flushMeasurements = () => {
  measurementFrame = undefined;
  const measurements = [...pendingMeasurements];
  pendingMeasurements.clear();
  measurements.forEach((measure) => {
    try {
      measure();
    } catch (error) {
      globalThis.setTimeout(() => { throw error; }, 0);
    }
  });
};

const scheduleMeasurement = (measure: LayoutMeasurement) => {
  pendingMeasurements.add(measure);
  if (measurementFrame !== undefined) return;
  measurementFrame = requestAnimationFrame(flushMeasurements);
};

const sharedObserver = () => {
  observer ??= new ResizeObserver((entries) => {
    entries.forEach((entry) => {
      measurementsByElement.get(entry.target)?.forEach(scheduleMeasurement);
    });
  });
  return observer;
};

export const observeLayout = (
  element: Element,
  measure: LayoutMeasurement,
) => {
  let measurements = measurementsByElement.get(element);
  if (!measurements) {
    measurements = new Set();
    measurementsByElement.set(element, measurements);
    sharedObserver().observe(element);
  }
  measurements.add(measure);
  scheduleMeasurement(measure);

  return () => {
    const current = measurementsByElement.get(element);
    current?.delete(measure);
    if (current?.size === 0) {
      measurementsByElement.delete(element);
      observer?.unobserve(element);
    }
    pendingMeasurements.delete(measure);
  };
};
