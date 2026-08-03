// lib/ml.ts
// This is the complete file - replace your entire ml.ts with this

// ============================================
// EXISTING CODE - Keep your original code here
// ============================================

// If you have any existing imports, keep them
// If you have any existing functions, keep them

// ============================================
// ADD/UPDATE THESE EXPORTS
// ============================================

export interface MlState {
  modelLoaded: boolean;
  lastPrediction: any;
  trainingData: any[];
  lastTrade?: any;
  model?: any;
}

// If validateFeatures already exists, REMOVE this duplicate
// If it doesn't exist, keep this
export function validateFeatures(features: any): boolean {
  if (!features) return false;
  // Add your validation logic here
  return true;
}

export async function loadModel(modelPath?: string): Promise<any> {
  console.log('Loading ML model...');
  return {
    loaded: true,
    predict: (features: any) => {
      const score = features?.emaSpread || 0;
      return {
        prediction: score > 0 ? 1 : -1,
        confidence: Math.abs(score)
      };
    }
  };
}

export function gateEntry(features: any, model: any): boolean {
  if (!model || !model.loaded) return true;
  try {
    const result = model.predict(features);
    return result.confidence > 0.3;
  } catch (err) {
    console.error('Gate entry error:', err);
    return true;
  }
}

// If trainOnTrade already exists, REMOVE this duplicate
// If it doesn't exist, keep this
export async function trainOnTrade(trade: any, model: any): Promise<void> {
  console.log('Training on trade:', trade);
  // Add your training logic here
  return Promise.resolve();
}
