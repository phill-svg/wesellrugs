import sharp from "sharp";
import { writeFileSync } from "node:fs";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#3b82f6"/>
  <path d="M120 150h272a40 40 0 0 1 40 40v132a40 40 0 0 1-40 40H210l-70 54v-54h-20a40 40 0 0 1-40-40V190a40 40 0 0 1 40-40z" fill="#fff"/>
</svg>`;

const buf = Buffer.from(svg);
for (const size of [192, 512, 180]) {
  const out = size === 180 ? "public/apple-touch-icon.png" : `public/icon-${size}.png`;
  const png = await sharp(buf).resize(size, size).png().toBuffer();
  writeFileSync(out, png);
  console.log("wrote", out, png.length, "bytes");
}
