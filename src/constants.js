/**
 * Values shared by both halves of the host code.
 *
 * Kept free of any native import on purpose: the plugin's main module and the
 * audio pipeline both read these, and importing them must never pull the
 * sherpa-onnx addon into the harness process (see `engine-host.js` for why).
 * @module dsh-koein/constants
 */

/** Sample rate every sherpa-onnx model used here expects. */
export const SAMPLE_RATE = 16000
