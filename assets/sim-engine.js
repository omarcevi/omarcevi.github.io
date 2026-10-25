// Inference simulator engine: a token-level model of an LLM serving engine on
// one H100, optionally split into MIG slices. It is a model, not a benchmark:
// step times come from a simple roofline (compute-bound vs memory-bound) and
// are meant to show the shape of the trade-offs, not predict real throughput.
// Pinned numbers: NVIDIA H100 SXM datasheet (989 TFLOPS dense BF16, 3.35 TB/s,
// 80 GB) and the Llama 3 8B config (8.03e9 params, 32 layers, 8 KV heads,
// head dim 128, so 131072 bytes of BF16 KV per token). GB means 1e9 bytes.
// No DOM access: it runs in Node for tests and as window.SimEngine in the page.
(function (root) {
  'use strict';

  // MIG profiles: share of compute (of 7 slices), of memory bandwidth (of 8), and memory in GB
  var PROFILES = {
    '7g.80gb': { compute: 7 / 7, bw: 8 / 8, memGB: 80 },
    '4g.40gb': { compute: 4 / 7, bw: 4 / 8, memGB: 40 },
    '3g.40gb': { compute: 3 / 7, bw: 4 / 8, memGB: 40 },
    '2g.20gb': { compute: 2 / 7, bw: 2 / 8, memGB: 20 },
    '1g.20gb': { compute: 1 / 7, bw: 2 / 8, memGB: 20 },
    '1g.10gb': { compute: 1 / 7, bw: 1 / 8, memGB: 10 }
  };

  var MODELS = {
    'llama-3-8b': { label: 'Llama 3 8B', params: 8.03e9, weightsGB: 16.06, kvBytesPerToken: 131072 }
  };

  var GPU = { tflops: 989, tbps: 3.35, mfu: 0.5, mbu: 0.8, stepOverheadMs: 1.5 };

  var DEFAULTS = {
    gpuMemUtil: 0.9,
    activationReserveGB: 1,
    maxNumSeqs: 256,
    maxNumBatchedTokens: 8192,
    maxTokens: 1024,
    maxBatch: 16,
    maxQueueDelayMs: 25,
    queueCap: 128
  };

  var nextId = 1;

  function pick(config, key) {
    return config && config[key] !== undefined ? config[key] : DEFAULTS[key];
  }

  function createInstance(profile, model, config) {
    var p = PROFILES[profile], m = MODELS[model];
    var usableGB = p.memGB * pick(config, 'gpuMemUtil') - m.weightsGB - pick(config, 'activationReserveGB');
    var kvBudget = Math.max(0, usableGB) * 1e9;
    return {
      id: nextId++,
      profile: profile,
      model: model,
      fits: kvBudget > 0,
      kvBudget: kvBudget,
      maxModelLen: 0,
      kvUsed: 0,
      queue: [],
      running: [],
      stepEnd: null,
      step: null,
      up: true
    };
  }

  // One engine step: the slower of the compute time and the memory time, plus fixed overhead
  function stepTimeMs(profile, model, prefillTokens, decodeSeqs, kvTokensRead) {
    var p = PROFILES[profile], m = MODELS[model];
    var flops = 2 * m.params * (prefillTokens + decodeSeqs);
    var bytes = m.weightsGB * 1e9 + kvTokensRead * m.kvBytesPerToken;
    var computeS = flops / (GPU.tflops * 1e12 * GPU.mfu * p.compute);
    var memoryS = bytes / (GPU.tbps * 1e12 * GPU.mbu * p.bw);
    return Math.max(computeS, memoryS) * 1000 + GPU.stepOverheadMs;
  }

  var api = {
    PROFILES: PROFILES,
    MODELS: MODELS,
    GPU: GPU,
    DEFAULTS: DEFAULTS,
    createInstance: createInstance,
    stepTimeMs: stepTimeMs
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SimEngine = api;
})(typeof window !== 'undefined' ? window : this);
