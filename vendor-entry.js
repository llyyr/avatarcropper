// Only third-party libraries are bundled. The application stays plain JavaScript.
import JSZip from "jszip";
import { parseGIF, decompressFrames } from "gifuct-js";
import * as gifenc from "gifenc";
const { GIFEncoder, quantize, applyPalette } = gifenc.GIFEncoder
  ? gifenc
  : gifenc.default;
export {
  JSZip,
  parseGIF,
  decompressFrames,
  GIFEncoder,
  quantize,
  applyPalette,
};
